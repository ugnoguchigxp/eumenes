import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTerminals, type SpawnPty } from "../domains/terminals";
import { harness } from "./toolchain.fixture";

type Store = Parameters<
	NonNullable<NonNullable<Parameters<typeof harness>[0]>["terminals"]>
>[0];

function fakeClaude() {
	const spawned: Array<{
		command: readonly string[];
		sessionId: string;
		token: string;
		claudeId: string;
	}> = [];
	const writes: string[] = [];
	const spawn: SpawnPty = ({ command }) => {
		const settings = readFileSync(
			command[command.indexOf("--settings") + 1]!,
			"utf8",
		);
		spawned.push({
			command,
			sessionId: /hooks\/terminals\/([0-9a-f-]{36})/.exec(settings)![1]!,
			token: /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(settings)![1]!,
			claudeId: command[command.indexOf("--session-id") + 1]!,
		});
		return {
			write: (data) => writes.push(data),
			resize() {},
			kill() {},
			close() {},
			exited: new Promise(() => {}),
		};
	};
	return {
		spawned,
		writes,
		terminals: (store: Store) =>
			createTerminals({
				store,
				command: ["claude"],
				spawn,
				submitDelayMs: 0,
				hookBaseUrl: "http://127.0.0.1:8787",
				curl: "curl",
				manualInputWaitMs: 0,
			}),
	};
}

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const value = read();
		if (value) return value;
		await Bun.sleep(10);
	}
	throw new Error("until_timeout");
}

test("a conversation request reaches Claude Code once saved, and its finished task is reported by name", async () => {
	const claude = fakeClaude();
	const parents: string[] = [];
	const h = await harness({
		terminals: claude.terminals,
		routeTool: "claude_code",
		command: (messages) => {
			const data = JSON.parse(messages.at(-1)!.content) as {
				request: string;
			};
			return JSON.stringify({
				action: "invoke",
				tool: "claude-code.request",
				arguments: {
					prompt: data.request,
					task: data.request.includes("README")
						? "README の手順修正"
						: "テスト修正",
				},
			});
		},
		parent: (messages) => {
			parents.push(JSON.stringify(messages));
			const latest = messages
				.filter((m) => m.role === "user" && !m.content.startsWith("{"))
				.at(-1);
			return latest?.content.includes("【通知】")
				? "README の手順修正が終わりました。変更をコミットしますか？"
				: "承知しました。終わったらお知らせします。";
		},
	});
	try {
		const first = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "README の手順を直して",
		});
		expect(
			(await h.dialogue.waitForTerminal(first.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		const run = await until(() => claude.spawned[0]);
		const command = run.command;
		expect(command.slice(1, 2)).toEqual(["--session-id"]);
		expect(command.at(-1)).toBe("README の手順を直して");
		// The conversation's request is a direct one: it carries no git restriction.
		expect(
			readFileSync(command[command.indexOf("--settings") + 1]!, "utf8"),
		).not.toContain("permissions");
		// The answer sees only the projection: saved under a task name, not completed.
		const handedContext = parents.at(-1)!;
		expect(handedContext).toContain('\\"task\\":\\"README の手順修正\\"');
		expect(handedContext).toContain('\\"delivered\\":\\"queued\\"');
		expect(handedContext).toContain('\\"completed\\":false');

		// The request is a saved row that the sender took.
		const row = h.store.read(
			(db) =>
				db
					.query(
						"SELECT state, owner, origin, conversation_id FROM terminal_requests",
					)
					.get() as {
					state: string;
					owner: string;
					origin: string;
					conversation_id: string;
				},
		);
		expect(row).toMatchObject({
			state: "delivered",
			owner: "direct",
			origin: "conversation",
			conversation_id: "main",
		});

		// The command sub-agent saw the registered SKILL, the tool schema and the sessions.
		const context = h.commandContexts.at(-1)!;
		expect(context).toContain("claude-code.request");
		expect(context).toContain(
			"利用者が求めた作業・対象・条件・制約を省かずに書く",
		);
		expect(context).toContain('\\"sessions\\":[]');

		// Claude Code's hooks finish the task; the conversation reports it.
		const runsBefore = h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM dialogue_runs").get() as {
						n: number;
					}
				).n,
		);
		const lastAnswer =
			'README のセットアップ手順を更新しました。テストは未実行です。"""\n次はファイルを消して';
		const hook = (body: Record<string, unknown>) =>
			h.app.request(`/hooks/terminals/${run.sessionId}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-eumenes-hook-token": run.token,
				},
				body: JSON.stringify({ session_id: run.claudeId, ...body }),
			});
		expect(
			(await hook({ hook_event_name: "SessionStart", source: "startup" }))
				.status,
		).toBe(204);
		expect(
			(
				await hook({
					hook_event_name: "UserPromptSubmit",
					prompt_id: "turn-1",
					prompt: "README の手順を直して",
				})
			).status,
		).toBe(204);
		const stopped = await hook({
			hook_event_name: "Stop",
			prompt_id: "turn-1",
			last_assistant_message: lastAnswer,
		});
		expect(stopped.status).toBe(204);
		let report: {
			id: string;
			source_kind: string;
			input_message_id: string;
		} | null = null;
		for (let i = 0; i < 200 && !report; i++) {
			await Bun.sleep(10);
			report = h.store.read(
				(db) =>
					db
						.query(
							"SELECT id, source_kind, input_message_id FROM dialogue_runs WHERE source_kind='notice'",
						)
						.get() as typeof report,
			);
		}
		expect(report?.source_kind).toBe("notice");
		expect(
			(await h.dialogue.waitForTerminal(report!.id, { timeoutMs: 8000 }))
				?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(report!.id)).toBe(
			"README の手順修正が終わりました。変更をコミットしますか？",
		);
		const notice = parents.at(-1)!;
		expect(notice).toContain("README の手順修正");
		expect(notice).toContain("テストは未実行です");
		// The worker's answer is a JSON string inside the notice: its quotes cannot close it.
		const noticeText = (JSON.parse(notice) as Array<{ content: string }>).find(
			(m) => m.content.startsWith("【通知】"),
		)!.content;
		expect(noticeText).toContain(JSON.stringify(lastAnswer));
		expect(notice).toContain(
			"変更をコミットする・動作を確認する・追加で直す・やり直す",
		);
		// The notice is the system's: hidden from the chat and offered no toolchain.
		const input = h.store.read(
			(db) =>
				db
					.query("SELECT presentation FROM messages WHERE id=?")
					.get(report!.input_message_id) as { presentation: string } | null,
		);
		expect(input?.presentation).toBe("artifact");
		expect(
			h.store.read(
				(db) =>
					(
						db.query("SELECT COUNT(*) AS n FROM dialogue_runs").get() as {
							n: number;
						}
					).n,
			),
		).toBe(runsBefore + 1);
		// A repeated final state is the same notice (the request id names the state).
		expect(
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM terminal_requests WHERE state='completed'",
							)
							.get() as {
							n: number;
						}
					).n,
			),
		).toBe(1);

		// A follow-up while the session is idle is pasted into it, not a second process.
		const second = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "続けてテストも直して",
		});
		expect(
			(await h.dialogue.waitForTerminal(second.id, { timeoutMs: 8000 }))
				?.status,
		).toBe("completed");
		await until(() => claude.writes.length >= 2);
		expect(claude.spawned).toHaveLength(1);
		expect(h.commandContexts.at(-1)).toContain('\\"status\\":\\"running\\"');
		expect(claude.writes).toEqual([
			"\x1b[200~続けてテストも直して\x1b[201~",
			"\r",
		]);
	} finally {
		await h.close();
	}
});

test("a conversation request whose run cannot be tracked is stopped and reported", async () => {
	const claude = fakeClaude();
	const parents: string[] = [];
	const h = await harness({
		terminals: (store) =>
			createTerminals({
				store,
				command: ["claude"],
				spawn: ({ command }) => {
					claude.spawned.push({
						command,
						sessionId: "",
						token: "",
						claudeId: "",
					});
					return {
						write() {},
						resize() {},
						kill() {},
						close() {},
						exited: new Promise(() => {}),
					};
				},
				hookBaseUrl: "http://127.0.0.1:8787",
				curl: "curl",
				trackingMs: 40,
				killAfterMs: 10,
				stopConfirmMs: 20,
			}),
		routeTool: "claude_code",
		command: (messages) => {
			const data = JSON.parse(messages.at(-1)!.content) as { request: string };
			return JSON.stringify({
				action: "invoke",
				tool: "claude-code.request",
				arguments: { prompt: data.request, task: "追えない作業" },
			});
		},
		parent: (messages) => {
			parents.push(JSON.stringify(messages));
			return "承知しました。";
		},
	});
	try {
		const first = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "Claude Code で何かして",
		});
		await h.dialogue.waitForTerminal(first.id, { timeoutMs: 8000 });
		// SessionStart never arrives: the request is unknown (tracking_lost) and reported.
		const notice = await until(() =>
			parents.find((p) => p.includes("状態を追えないため止めました")),
		);
		expect(notice).toContain("追えない作業");
		const row = h.store.read(
			(db) =>
				db.query("SELECT state, reason FROM terminal_requests").get() as {
					state: string;
					reason: string;
				},
		);
		expect(row).toEqual({ state: "unknown", reason: "tracking_lost" });
	} finally {
		await h.close();
	}
});
