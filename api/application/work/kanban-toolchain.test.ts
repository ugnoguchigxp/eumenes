import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTerminals, type SpawnPty } from "../../domains/terminals";
import { WORK_ONLY_INSTRUCTION } from "../../domains/kanban";
import { harness } from "../toolchain/toolchain.fixture";
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
const dataOf = (messages: Messages) =>
	JSON.parse(messages.at(-1)!.content) as CommandData;
const invoke = (tool: string, args: unknown) =>
	JSON.stringify({ action: "invoke", tool, arguments: args });

/** A board over fake Claude Code; `command` plays the sub-agent model. */
async function board(command: (data: CommandData) => string) {
	const claude = fakeClaude();
	const h = await harness({
		terminals: claude.terminals,
		kanban: true,
		routeTool: "kanban",
		command: (messages) => command(dataOf(messages)),
	});
	return { h, claude };
}

async function say(h: Harness, text: string) {
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
	});
	const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
	return { run, status: done?.status };
}

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

test("a conversation registers a card from the user's words; nothing is run and the sub-agent saw the SKILL and the board", async () => {
	const { h, claude } = await board((data) =>
		invoke("kanban.add", {
			title: "README の手順修正",
			prompt: data.request,
		}),
	);
	try {
		const { status } = await say(
			h,
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
		// Registering is not running: no PTY, no run, no request.
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
		// The agency is given the short projection of the saved card.
		const answer = h.reported();
		expect(answer).toContain('"action":"added"');
		expect(answer).toContain("README の手順修正");
		expect(answer).not.toContain("queued");
	} finally {
		await h.close();
	}
});

test("an ambiguous target is asked with the board's own cards; only one of them answers, and the run goes to the chosen card", async () => {
	const { h, claude } = await board((data) => {
		const answered = data.previousQuestions?.at(-1);
		if (!answered)
			return JSON.stringify({
				action: "clarify",
				question: "どのタスクを実行しますか？",
				answerSchema: "builtin:kanbanCardAnswer",
			});
		const chosen = data.snapshot.cards.find((card) =>
			JSON.stringify(answered.answer).includes(card.id),
		)!;
		return invoke("kanban.run", {
			cardId: chosen.id,
			expectedRevision: chosen.revision,
		});
	});
	try {
		const readme = await addCard(h, "README の手順修正");
		const login = await addCard(h, "ログイン画面のバグ修正");
		const asked = await say(h, "あのタスクを実行して");
		expect(asked.status).toBe("completed");
		expect(claude.spawned).toHaveLength(0);
		// The question lists the board's cards, issued by the host.
		const list = await (
			await h.request(
				"/api/toolchain-interactions?conversationId=main&status=waiting_input",
			)
		).json();
		expect(list).toHaveLength(1);
		const interaction = list[0] as {
			id: string;
			revision: number;
			question: {
				questionId: string;
				inputSchemaRef: string;
				choices: Array<{ ref: string; label: string }>;
			};
		};
		expect(interaction.question.inputSchemaRef).toBe(
			"builtin:kanbanCardAnswer",
		);
		expect(interaction.question.choices).toEqual([
			{ ref: readme.cardId, label: "README の手順修正（未着手）" },
			{ ref: login.cardId, label: "ログイン画面のバグ修正（未着手）" },
		]);
		const answer = (input: unknown) =>
			h.request(`/api/toolchain-interactions/${interaction.id}/answers`, {
				eventId: crypto.randomUUID(),
				questionId: interaction.question.questionId,
				expectedRevision: interaction.revision,
				input,
			});
		// A card the board never offered is refused; so is an answer of another shape.
		expect(
			(await answer({ cardId: crypto.randomUUID() })).status,
		).toBeGreaterThanOrEqual(400);
		expect((await answer({ text: "ログイン" })).status).toBeGreaterThanOrEqual(
			400,
		);
		expect(cardsOf(h).map((card) => card.column)).toEqual(["todo", "todo"]);
		const accepted = await answer({ cardId: login.cardId });
		expect(accepted.status).toBe(202);
		const { runId } = (await accepted.json()) as { runId: string };
		expect(
			(await h.dialogue.waitForTerminal(runId, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		const spawned = await until(() => claude.spawned[0]);
		expect(spawned.command.at(-1)).toContain("ログイン画面のバグ修正 の依頼");
		expect(cardsOf(h).map(({ title, column }) => ({ title, column }))).toEqual([
			{ title: "README の手順修正", column: "todo" },
			{ title: "ログイン画面のバグ修正", column: "running" },
		]);
		// The result says the run is queued, not done.
		const context = h.reported();
		expect(context).toContain('"queued":true');
		expect(context).toContain('"completed":false');
		expect(context).toContain("通知センター");
	} finally {
		await h.close();
	}
});

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

test("running from the conversation queues the user's words under the work-only restriction; the result goes to the notification center, not the conversation", async () => {
	const { h, claude } = await board((data) => {
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
		await say(h, "README を直して push までやるタスクを登録して");
		expect(cardsOf(h)[0]!.prompt).toBe("README を直して push まで");
		expect((await say(h, "それを実行して")).status).toBe("completed");
		const run = await until(() => claude.spawned[0]);
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
		).toMatchObject({ origin: "conversation" });
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
		await h.close();
	}
});

test("a status question reads the board: a Done card's report comes from the list, and the card bodies stay out of the snapshot", async () => {
	const { h, claude } = await board((data) => {
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
		await say(h, "テスト修正を実行して");
		const run = await until(() => claude.spawned[0]);
		await finishRun(h, run, run.command.at(-1)!, "テストを 3 件直しました。");
		await until(() => cardsOf(h).some((card) => card.label === "done"));
		expect((await say(h, "テスト修正の報告を教えて")).status).toBe("completed");
		// The sub-agent's snapshot has ids and states, never a prompt or a report.
		const sent = h.commandContexts.at(-1)!;
		expect(sent).toContain('\\"label\\":\\"done\\"');
		expect(sent).not.toContain("秘密の依頼本文");
		expect(sent).not.toContain("テストを 3 件直しました");
		// The result is the list: the clipped report of the Done card and the fixed guidance.
		const context = h.reported();
		expect(context).toContain('"kind":"kanban_list"');
		expect(context).toContain("テストを 3 件直しました。");
		expect(context).toContain("文書整理");
		expect(context).not.toContain("秘密の依頼本文");
		expect(context).toContain("通知センターでお知らせします");
	} finally {
		await h.close();
	}
});

test("a commit & push request changes nothing: there is no such tool, and the list result carries the board's button as the guidance", async () => {
	const { h, claude } = await board(() => invoke("kanban.list", {}));
	try {
		await addCard(h, "README の修正");
		const before = JSON.stringify(cardsOf(h));
		expect((await say(h, "このタスクを commit して push して")).status).toBe(
			"completed",
		);
		expect(JSON.stringify(cardsOf(h))).toBe(before);
		expect(claude.spawned).toHaveLength(0);
		expect(count(h, "SELECT COUNT(*) AS n FROM terminal_requests")).toBe(0);
		expect(count(h, "SELECT COUNT(*) AS n FROM kanban_runs")).toBe(0);
		expect(h.commandContexts.at(-1)).not.toContain("commit-push");
		// The guidance is in the result of the list.
		expect(h.reported()).toContain(
			"タスクボードで内容を確認してから commit & push を押してください",
		);
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
		await h.close();
	}
});

test("edit, move and remove go through the bound tools with the board's revisions; a stale revision changes nothing", async () => {
	const { h } = await board((data) => {
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
		await say(h, "題名を直して");
		expect(cardsOf(h)[0]).toMatchObject({ title: "新しい題名", revision: 2 });
		await say(h, "終わった扱いにして");
		expect(cardsOf(h)[0]).toMatchObject({ column: "finished", label: "done" });
		expect(h.reported()).toContain('"action":"moved"');
		const before = JSON.stringify(cardsOf(h));
		expect((await say(h, "古い版で消して")).status).toBe("completed");
		expect(h.reported()).toContain("revision_conflict");
		expect(JSON.stringify(cardsOf(h))).toBe(before);
		expect((await say(h, "消して")).status).toBe("completed");
		expect(cardsOf(h)).toEqual([]);
	} finally {
		await h.close();
	}
});
