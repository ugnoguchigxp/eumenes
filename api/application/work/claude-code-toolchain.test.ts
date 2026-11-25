import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTerminals, type SpawnPty } from "../../domains/terminals";
import { harness } from "../toolchain/toolchain.fixture";
import {
	ask,
	assignmentAgenda,
	executions,
	items,
	notes,
	reportLine,
	until as agentUntil,
} from "../media/assignment.fixture";

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
		const settingsPath = command[command.indexOf("--settings") + 1]!;
		const settings = readFileSync(settingsPath, "utf8");
		spawned.push({
			command,
			sessionId: /hooks\/terminals\/([0-9a-f-]{36})/.exec(settings)![1]!,
			token: /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(
				readFileSync(/-H @'([^']+)'/.exec(settings)![1]!, "utf8"),
			)![1]!,
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
		terminals: (store: Store) => {
			const terminals = createTerminals({
				store,
				command: ["claude"],
				spawn,
				submitDelayMs: 0,
				hookBaseUrl: "http://127.0.0.1:8787",
				curl: "curl",
				manualInputWaitMs: 0,
			});
			// The host recovers at startup, before anything is sent.
			void terminals.recover();
			return terminals;
		},
	};
}

test("a request to Claude Code is the agent's assignment: it reaches Claude Code once saved, and the finished task is reported by the agent", async () => {
	const claude = fakeClaude();
	const a = await assignmentAgenda({
		harness: {
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
		},
	});
	const h = a.h;
	try {
		await a.start();
		await ask(a, "claude-code.request", "README の手順を直して");
		// There is no confirmation: the user's words start the work.
		await agentUntil(a, () => claude.spawned.length > 0);
		const run = claude.spawned[0]!;
		const command = run.command;
		expect(command.slice(1, 2)).toEqual(["--session-id"]);
		expect(command.at(-1)).toBe("README の手順を直して");
		// The assignment's request is a direct one: it carries no git restriction.
		expect(
			readFileSync(command[command.indexOf("--settings") + 1]!, "utf8"),
		).not.toContain("permissions");
		// The request is a saved row that the sender took, and the assignment waits for the task's end.
		expect(executions(a)).toMatchObject([{ status: "waiting_child" }]);
		expect(items(a)).toHaveLength(1);
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
			origin: "execution",
			conversation_id: "ao",
		});

		// The command sub-agent saw the registered SKILL, the tool schema and the sessions.
		const context = h.commandContexts.at(-1)!;
		expect(context).toContain("claude-code.request");
		expect(context).toContain(
			"利用者が求めた作業・対象・条件・制約を省かずに書く",
		);
		expect(context).toContain('\\"sessions\\":[]');

		// Claude Code's hooks finish the task; the agent reports it.
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
		expect(
			(
				await hook({
					hook_event_name: "Stop",
					prompt_id: "turn-1",
					last_assistant_message: lastAnswer,
				})
			).status,
		).toBe(204);
		await agentUntil(a, () => notes(a).length === 1);
		expect(executions(a)).toMatchObject([{ status: "completed" }]);
		expect(items(a)).toHaveLength(0);
		const [note] = notes(a);
		expect(note!.title).toBe("作業報告: README の手順を直して");
		expect(note!.markdown).toContain("README のセットアップ手順を更新しました");
		expect(note!.markdown).toContain("テストは未実行です");
		await agentUntil(a, () => !!reportLine(a));
		// The agent's report is the only one: the task's owner sent no notice run to the conversation.
		expect(
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM dialogue_runs WHERE source_kind='notice'",
							)
							.get() as { n: number }
					).n,
			),
		).toBe(0);
		// A repeated final state is the same task: one completed request, one report.
		expect(
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM terminal_requests WHERE state='completed'",
							)
							.get() as { n: number }
					).n,
			),
		).toBe(1);

		// A follow-up while the session is idle is pasted into it, not a second process.
		await ask(a, "claude-code.request", "続けてテストも直して");
		await agentUntil(a, () => claude.writes.length >= 2);
		expect(claude.spawned).toHaveLength(1);
		expect(h.commandContexts.at(-1)).toContain('\\"status\\":\\"running\\"');
		expect(claude.writes).toEqual([
			"\x1b[200~続けてテストも直して\x1b[201~",
			"\r",
		]);
	} finally {
		await a.close();
	}
}, 30_000);

test("an assignment to Claude Code whose run cannot be tracked is stopped and reported as failed", async () => {
	const claude = fakeClaude();
	const a = await assignmentAgenda({
		harness: {
			terminals: (store) => {
				const terminals = createTerminals({
					store,
					command: ["claude"],
					spawn: ({ command }) => {
						claude.spawned.push({
							command,
							sessionId: "",
							token: "",
							claudeId: "",
						});
						let exit!: (code: number | null) => void;
						const exited = new Promise<number | null>((resolve) => {
							exit = resolve;
						});
						return {
							write() {},
							resize() {},
							// The process ends when it is told to: the exit is confirmed.
							kill: () => exit(null),
							close() {},
							exited,
						};
					},
					hookBaseUrl: "http://127.0.0.1:8787",
					curl: "curl",
					trackingMs: 40,
					killAfterMs: 10,
					stopConfirmMs: 200,
				});
				void terminals.recover();
				return terminals;
			},
			routeTool: "claude_code",
			command: () =>
				JSON.stringify({
					action: "invoke",
					tool: "claude-code.request",
					arguments: { prompt: "Claude Code で何かして", task: "追えない作業" },
				}),
		},
	});
	const h = a.h;
	const requestRow = () =>
		h.store.read(
			(db) =>
				db.query("SELECT state, reason FROM terminal_requests").get() as {
					state: string;
					reason: string;
				} | null,
		);
	try {
		await a.start();
		await ask(a, "claude-code.request", "Claude Code で何かして");
		// SessionStart never arrives: the request is unknown (tracking_lost) and the assignment ends without a result.
		await agentUntil(a, () => requestRow()?.state === "unknown");
		expect(requestRow()).toEqual({ state: "unknown", reason: "tracking_lost" });
		await agentUntil(a, () =>
			items(a).every((item) => item.kind !== "research"),
		);
		expect(claude.spawned).toHaveLength(1);
		// Nothing was done, so there is no work report note; the agent tells it failed.
		expect(notes(a)).toEqual([]);
		expect(items(a)).toEqual([]);
	} finally {
		await a.close();
	}
}, 30_000);
