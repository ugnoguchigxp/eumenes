import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTerminals, type SpawnPty } from "../../domains/terminals";
import { WORK_ONLY_INSTRUCTION } from "../../domains/kanban";
import type { harness } from "../toolchain/toolchain.fixture";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	ended,
	executions,
	items,
	until as untilAgent,
	type Fixture,
} from "../media/assignment.fixture";
import { waitFor } from "../../infrastructure/wait-for";

type Store = Parameters<
	NonNullable<NonNullable<Parameters<typeof harness>[0]>["terminals"]>
>[0];
type Harness = Awaited<ReturnType<typeof harness>>;
type Messages = Parameters<
	NonNullable<NonNullable<Parameters<typeof harness>[0]>["command"]>
>[0];

/** Claude Code stand-in: records each spawn with the hook address its settings file carries. */
function fakeClaude() {
	const spawned: Array<{
		command: readonly string[];
		settings: string;
		sessionId: string;
		token: string;
		claudeId: string;
	}> = [];
	const spawn: SpawnPty = ({ command }) => {
		const settings = readFileSync(
			command[command.indexOf("--settings") + 1]!,
			"utf8",
		);
		spawned.push({
			command,
			settings,
			sessionId: /hooks\/terminals\/([0-9a-f-]{36})/.exec(settings)![1]!,
			token: /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(
				readFileSync(/-H @'([^']+)'/.exec(settings)![1]!, "utf8"),
			)![1]!,
			claudeId: command[command.indexOf("--session-id") + 1]!,
		});
		return {
			write() {},
			resize() {},
			kill() {},
			close() {},
			exited: new Promise(() => {}),
		};
	};
	return {
		spawned,
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
			// Terminals dispatches nothing until its startup recovery has run.
			void terminals.recover();
			return terminals;
		},
	};
}

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
	let value: T | null | undefined | false = undefined;
	await waitFor(() => !!(value = read()));
	return value as T;
}

type CommandData = {
	request: string;
	snapshot: {
		runnable: boolean;
		cards: Array<{
			id: string;
			title: string;
			revision: number;
			column: string;
			allowed: string[];
		}>;
	};
	previousQuestions?: Array<{ question: string; answer: unknown }>;
};
/** The sub-agent's input: its request is the user's words the assignment was made of. */
const dataOf = (messages: Messages) =>
	JSON.parse(messages.at(-1)!.content) as CommandData;
const invoke = (tool: string, args: unknown) =>
	JSON.stringify({ action: "invoke", tool, arguments: args });

/** A board over fake Claude Code; `command` plays the sub-agent model. */
async function board(command: (data: CommandData) => string) {
	const claude = fakeClaude();
	const a = await assignmentAgenda({
		harness: {
			terminals: claude.terminals,
			kanban: true,
			routeTool: "kanban",
			command: (messages) => command(dataOf(messages)),
		},
	});
	await a.start();
	return { a, h: a.h, claude };
}

/** The user asks the board for something: the assignment is made of their words and runs to its end at its owner. */
async function say(a: Fixture, text: string) {
	const known = new Set(executions(a).map((e) => e.id));
	const { source } = await ask(a, "kanban.manage", text);
	const fresh = () => executions(a).find((e) => !known.has(e.id));
	await untilAgent(
		a,
		() =>
			!!fresh() &&
			["completed", "failed", "cancelled"].includes(fresh()!.status),
	);
	return { source, status: fresh()!.status };
}

/** What the board's operations answered the assignments (each step's own result, whole). */
const results = (h: Harness) =>
	h.store
		.read((db) =>
			db
				.query("SELECT result_json FROM agent_execution_steps ORDER BY rowid")
				.all(),
		)
		.map((row) => (row as { result_json: string }).result_json)
		.join("\n");

const cardsOf = (h: Harness) =>
	h.store.read((db) => h.kanban!.boardInTransaction(db, { runnable: true }))
		.cards;
const addCard = (h: Harness, title: string, prompt = `${title} の依頼`) =>
	h.store.write(
		(db) =>
			h.kanban!.addInTransaction(db, { title, prompt }, crypto.randomUUID())
				.receipt as { cardId: string },
	);
const count = (h: Harness, sql: string) =>
	h.store.read((db) => (db.query(sql).get() as { n: number }).n);

test("the user's words register a card as the agent's assignment; nothing is run and the sub-agent saw the SKILL and the board", async () => {
	const { a, h, claude } = await board((data) =>
		invoke("kanban.add", {
			title: "README の手順修正",
			prompt: data.request,
		}),
	);
	try {
		const { status } = await say(
			a,
			"README の手順を最新にするタスクを登録して",
		);
		expect(status).toBe("completed");
		const cards = cardsOf(h);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			title: "README の手順修正",
			prompt: "README の手順を最新にするタスクを登録して",
			column: "todo",
		});
		// Registering is not running: no PTY, no request.
		expect(claude.spawned).toHaveLength(0);
		expect(count(h, "SELECT COUNT(*) AS n FROM terminal_requests")).toBe(0);
		// The sub-agent saw the registered SKILL, the tools without commit & push, and the board.
		const context = h.commandContexts.at(-1)!;
		expect(context).toContain("省略や言い換えなしで書き");
		for (const tool of [
			"kanban.add",
			"kanban.list",
			"kanban.edit",
			"kanban.move",
			"kanban.run",
			"kanban.followup",
			"kanban.cancel",
			"kanban.remove",
		])
			expect(context).toContain(`\\"id\\":\\"${tool}\\"`);
		expect(context).not.toContain("commit-push");
		expect(context).not.toContain('\\"id\\":\\"kanban.commit');
		expect(context).toContain('\\"cards\\":[]');
		// The agent is given the short projection of the saved card.
		const answer = results(h);
		expect(answer).toContain('"action":"added"');
		expect(answer).toContain("README の手順修正");
		expect(answer).not.toContain("queued");
	} finally {
		await a.close();
	}
}, 30_000);

test("an ambiguous target is the assignment's question; nothing runs while it is open, and stopping the assignment keeps every card as it was", async () => {
	const { a, h, claude } = await board(() =>
		JSON.stringify({
			action: "clarify",
			question: "どのタスクを実行しますか？",
			answerSchema: "builtin:kanbanCardAnswer",
		}),
	);
	try {
		await addCard(h, "README の手順修正");
		await addCard(h, "ログイン画面のバグ修正");
		const before = JSON.stringify(cardsOf(h));
		const { id } = await ask(a, "kanban.manage", "あのタスクを実行して");
		await untilAgent(a, () => !!items(a)[0]?.question);
		expect(items(a)[0]!.question).toBe("どのタスクを実行しますか？");
		expect(executions(a)).toMatchObject([{ status: "waiting_user" }]);
		expect(claude.spawned).toHaveLength(0);
		expect(JSON.stringify(cardsOf(h))).toBe(before);
		await cancelAssignment(a, id);
		await untilAgent(a, () => items(a).length === 0);
		expect(claude.spawned).toHaveLength(0);
		expect(JSON.stringify(cardsOf(h))).toBe(before);
	} finally {
		await a.close();
	}
}, 30_000);

/** Claude Code's hooks for one spawned PTY: start, one turn, stop with a report. */
async function finishRun(
	h: Harness,
	run: { sessionId: string; token: string; claudeId: string },
	prompt: string,
	report: string,
) {
	const hook = (body: Record<string, unknown>) =>
		h.app.request(`/hooks/terminals/${run.sessionId}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-eumenes-hook-token": run.token,
			},
			body: JSON.stringify({ session_id: run.claudeId, ...body }),
		});
	await hook({ hook_event_name: "SessionStart", source: "startup" });
	await hook({
		hook_event_name: "UserPromptSubmit",
		prompt_id: "turn-1",
		prompt,
	});
	return hook({
		hook_event_name: "Stop",
		prompt_id: "turn-1",
		last_assistant_message: report,
	});
}

test("running as the agent's assignment queues the user's words under the work-only restriction; the result goes to the notification center, not the conversation", async () => {
	const { a, h, claude } = await board((data) => {
		const target = data.snapshot.cards[0]!;
		return data.request.includes("登録")
			? invoke("kanban.add", {
					title: "README の修正",
					prompt: "README を直して push まで",
				})
			: invoke("kanban.run", {
					cardId: target.id,
					expectedRevision: target.revision,
				});
	});
	try {
		// "...push まで": only the work is registered, in the user's words.
		await say(a, "README を直して push までやるタスクを登録して");
		expect(cardsOf(h)[0]!.prompt).toBe("README を直して push まで");
		// A run lasts as long as Claude Code works: the assignment ends with the card, not when it is queued.
		await ask(a, "kanban.manage", "それを実行して");
		await untilAgent(a, () => claude.spawned.length > 0);
		const run = claude.spawned[0]!;
		expect(run.command.at(-1)).toBe(
			`README を直して push まで\n\n${WORK_ONLY_INSTRUCTION}`,
		);
		expect(run.settings).toContain('"permissions"');
		expect(run.settings).toContain("Bash(git commit *)");
		expect(run.settings).toContain("Bash(git push *)");
		expect(count(h, "SELECT COUNT(*) AS n FROM terminal_requests")).toBe(1);
		expect(
			h.store.read(
				(db) =>
					db.query("SELECT origin, owner FROM terminal_requests").get() as {
						origin: string;
						owner: string;
					},
			),
		).toMatchObject({ origin: "execution" });
		const runsBefore = count(h, "SELECT COUNT(*) AS n FROM dialogue_runs");
		const stopped = await finishRun(
			h,
			run,
			run.command.at(-1)!,
			"README を更新しました。push はしていません。",
		);
		expect(stopped.status).toBe(204);
		const card = await until(() =>
			cardsOf(h).find((c) => c.column === "finished" && c.label === "done"),
		);
		expect(card.lastReport).toContain("README を更新しました");
		await untilAgent(a, () => ended(a, 2));
		expect(executions(a).map((e) => e.status)).toEqual([
			"completed",
			"completed",
		]);
		// The notification center gets the notice; the conversation gets nothing.
		const notices = h.kanban!.notices(10).notices;
		expect(notices.map((notice) => notice.kind)).toEqual(["done"]);
		// A negative check: give a late, timer-driven notice real time to appear.
		await Bun.sleep(150);
		expect(count(h, "SELECT COUNT(*) AS n FROM dialogue_runs")).toBe(
			runsBefore,
		);
		expect(
			count(
				h,
				"SELECT COUNT(*) AS n FROM dialogue_runs WHERE source_kind='notice'",
			),
		).toBe(0);
	} finally {
		await a.close();
	}
}, 30_000);

test("a status question reads the board: a Done card's report comes from the list, and the card bodies stay out of the snapshot", async () => {
	const { a, h, claude } = await board((data) => {
		if (data.request.includes("報告")) return invoke("kanban.list", {});
		const target = data.snapshot.cards[0]!;
		return invoke("kanban.run", {
			cardId: target.id,
			expectedRevision: target.revision,
		});
	});
	try {
		await addCard(h, "テスト修正", "秘密の依頼本文");
		await addCard(h, "文書整理");
		await ask(a, "kanban.manage", "テスト修正を実行して");
		await untilAgent(a, () => claude.spawned.length > 0);
		const run = claude.spawned[0]!;
		await finishRun(h, run, run.command.at(-1)!, "テストを 3 件直しました。");
		await until(() => cardsOf(h).some((card) => card.label === "done"));
		await untilAgent(a, () => ended(a));
		expect((await say(a, "テスト修正の報告を教えて")).status).toBe("completed");
		// The sub-agent's snapshot has ids and states, never a prompt or a report.
		const sent = h.commandContexts.at(-1)!;
		expect(sent).toContain('\\"label\\":\\"done\\"');
		expect(sent).not.toContain("秘密の依頼本文");
		expect(sent).not.toContain("テストを 3 件直しました");
	} finally {
		await a.close();
	}
}, 30_000);

test("a commit & push request changes nothing: there is no such tool, and the list result carries the board's button as the guidance", async () => {
	const { a, h, claude } = await board(() => invoke("kanban.list", {}));
	try {
		await addCard(h, "README の修正");
		const before = JSON.stringify(cardsOf(h));
		expect((await say(a, "このタスクを commit して push して")).status).toBe(
			"completed",
		);
		expect(JSON.stringify(cardsOf(h))).toBe(before);
		expect(claude.spawned).toHaveLength(0);
		expect(count(h, "SELECT COUNT(*) AS n FROM terminal_requests")).toBe(0);
		expect(count(h, "SELECT COUNT(*) AS n FROM kanban_runs")).toBe(0);
		expect(h.commandContexts.at(-1)).not.toContain("commit-push");
		// Even a registered operation cannot make the conversation commit: the adapter refuses it.
		await expect(
			h.store.write((db) =>
				h.toolchain.registry.get("adapter:kanban@1")!.invokeInTransaction(db, {
					operationName: "kanban.commit-push",
					input: {
						cardId: cardsOf(h)[0]!.id,
						expectedRevision: cardsOf(h)[0]!.revision,
					},
					requestId: crypto.randomUUID(),
					issuedAt: new Date().toISOString(),
					origin: {
						kind: "conversation",
						owner: {} as never,
						runId: "r",
						conversationId: "main",
						messageId: "m",
					},
				}),
			),
		).rejects.toThrow("commit_push_requires_board");
	} finally {
		await a.close();
	}
}, 30_000);

test("edit, move and remove go through the bound tools with the board's revisions; a stale revision changes nothing", async () => {
	const { a, h } = await board((data) => {
		const target = data.snapshot.cards[0]!;
		const ref = { cardId: target.id, expectedRevision: target.revision };
		if (data.request.includes("題名"))
			return invoke("kanban.edit", { ...ref, title: "新しい題名" });
		if (data.request.includes("終わった扱い"))
			return invoke("kanban.move", {
				...ref,
				column: "finished",
				beforeCardId: null,
			});
		if (data.request.includes("古い"))
			return invoke("kanban.remove", {
				...ref,
				expectedRevision: target.revision - 1 || 99,
			});
		return invoke("kanban.remove", ref);
	});
	try {
		await addCard(h, "古いタスク");
		await say(a, "題名を直して");
		expect(cardsOf(h)[0]).toMatchObject({ title: "新しい題名", revision: 2 });
		await say(a, "終わった扱いにして");
		expect(cardsOf(h)[0]).toMatchObject({ column: "finished", label: "done" });
		expect(results(h)).toContain('"action":"moved"');
		const before = JSON.stringify(cardsOf(h));
		// The stale revision is refused by the board: the assignment ends failed and changes nothing.
		expect((await say(a, "古い版で消して")).status).toBe("failed");
		expect(results(h)).toContain("revision_conflict");
		expect(JSON.stringify(cardsOf(h))).toBe(before);
		expect((await say(a, "消して")).status).toBe("completed");
		expect(cardsOf(h)).toEqual([]);
	} finally {
		await a.close();
	}
}, 30_000);
