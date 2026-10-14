import { expect, test } from "bun:test";
import { createTerminals, type SpawnPty } from "../domains/terminals";
import { harness } from "./toolchain.fixture";

function fakeClaude() {
	const commands: Array<readonly string[]> = [];
	const writes: string[] = [];
	const spawn: SpawnPty = ({ command }) => {
		commands.push(command);
		return {
			write: (data) => writes.push(data),
			resize() {},
			kill() {},
			close() {},
			exited: new Promise(() => {}),
		};
	};
	return {
		commands,
		writes,
		terminals: createTerminals({
			command: ["claude"],
			spawn,
			submitDelayMs: 0,
			hookBaseUrl: "http://127.0.0.1:8787",
		}),
	};
}
const tokenOf = (command: readonly string[]) =>
	/x-eumenes-hook-token: ([0-9a-f]{64})/.exec(command[2]!)![1]!;

test("a conversation request reaches Claude Code, and its finished task is reported by name", async () => {
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
		const command = claude.commands[0]!;
		expect(command[1]).toBe("--settings");
		expect(command.at(-1)).toBe("README の手順を直して");
		// The answer sees only the projection: handed over by task name, not completed.
		const handedContext = parents.at(-1)!;
		expect(handedContext).toContain('\\"task\\":\\"README の手順修正\\"');
		expect(handedContext).toContain('\\"completed\\":false');

		// The command sub-agent saw the registered SKILL, the tool schema and the sessions.
		const context = h.commandContexts.at(-1)!;
		expect(context).toContain("claude-code.request");
		expect(context).toContain(
			"利用者が求めた作業・対象・条件・制約を省かずに書く",
		);
		expect(context).toContain('\\"sessions\\":[]');

		// Claude Code's Stop hook finishes the task; the conversation reports it.
		const runsBefore = h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM dialogue_runs").get() as {
						n: number;
					}
				).n,
		);
		const session = claude.terminals.list().sessions[0]!;
		const hook = await h.app.request(`/hooks/terminals/${session.id}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-eumenes-hook-token": tokenOf(command),
			},
			body: JSON.stringify({
				hook_event_name: "Stop",
				last_assistant_message:
					"README のセットアップ手順を更新しました。テストは未実行です。",
			}),
		});
		expect(hook.status).toBe(204);
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

		// A follow-up while the session runs is typed into it.
		const second = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "続けてテストも直して",
		});
		expect(
			(await h.dialogue.waitForTerminal(second.id, { timeoutMs: 8000 }))
				?.status,
		).toBe("completed");
		expect(claude.commands).toHaveLength(1);
		expect(h.commandContexts.at(-1)).toContain('\\"status\\":\\"running\\"');
		await Bun.sleep(5);
		expect(claude.writes).toEqual([
			"\x1b[200~続けてテストも直して\x1b[201~",
			"\r",
		]);
	} finally {
		await h.close();
		claude.terminals.closeAll();
	}
});
