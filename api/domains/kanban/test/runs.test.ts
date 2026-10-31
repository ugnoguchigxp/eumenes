import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { WORK_ONLY_INSTRUCTION, type KanbanDispatch } from "..";
import { openKanban } from "./kanban.fixture";
import { KANBAN_PROMPT_MAX } from "../contracts";
import type { KanbanRunFinish } from "../contracts";

let req = 0;
const rid = () => `run-req-${++req}`;
const VIEW = { runnable: true };
const BOARD = { origin: "board" as const, runnable: true };
const CHAT = {
	origin: "conversation" as const,
	conversationId: "main",
	runnable: true,
};

/** A harness with cards and the operations a test repeats. */
function setup() {
	const { store, kanban } = openKanban();
	const card = async (title: string) =>
		(
			await store.write((tx) =>
				kanban.addInTransaction(
					tx,
					{ title, prompt: `${title} の依頼` },
					rid(),
				),
			)
		).receipt;
	const view = (cardId: string) =>
		kanban.board(VIEW).cards.find((c) => c.id === cardId)!;
	const run = async (cardId: string, context = BOARD) =>
		store.write((tx) =>
			kanban.runInTransaction(
				tx,
				{ cardId, expectedRevision: view(cardId).revision },
				rid(),
				context,
			),
		);
	const finish = (
		runId: string,
		state: KanbanRunFinish["state"] = "completed",
		over: Partial<KanbanRunFinish> = {},
	) =>
		store.write((tx) =>
			kanban.finishRunInTransaction(tx, {
				runId,
				state,
				lastReport: "報告",
				files: ["a.ts"],
				...over,
			}),
		);
	return { store, kanban, card, view, run, finish };
}
const first = <T>(items: readonly T[]) => items[0]!;

test("a run puts the card in running and only the first run is handed over", async () => {
	const { kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const one = await run(a.cardId);
	const two = await run(b.cardId);
	expect(one.dispatch).toMatchObject({
		cardId: a.cardId,
		kind: "task",
		target: "new",
		mode: "work",
		projectId: "eumenes",
		task: "A",
		origin: "board",
	});
	expect(one.dispatch!.prompt).toBe(`A の依頼\n\n${WORK_ONLY_INSTRUCTION}`);
	expect(one.dispatch!.runId).toBe(one.receipt.runId!);
	expect(two.dispatch).toBeUndefined();
	expect(view(a.cardId)).toMatchObject({
		column: "running",
		actions: ["stop", "open"],
		currentRunId: one.receipt.runId,
	});
	expect(view(b.cardId).actions).toEqual(["cancel"]);
	const board = kanban.board(VIEW);
	expect(board.queue).toEqual({
		state: "running",
		waiting: 1,
		handedRunId: one.receipt.runId,
	});
	expect(board.runs.map((r) => r.state)).toEqual(["handed", "waiting_turn"]);
	// Every task starts its own conversation.
	expect(board.runs[0]!.claudeSessionId).not.toBe(
		board.runs[1]!.claudeSessionId,
	);
});

test("the same request replays without handing over again; stale or busy cards are refused", async () => {
	const { store, kanban, card, view } = setup();
	const a = await card("A");
	const input = { cardId: a.cardId, expectedRevision: 1 };
	const once = await store.write((tx) =>
		kanban.runInTransaction(tx, input, "same", BOARD),
	);
	const again = await store.write((tx) =>
		kanban.runInTransaction(tx, input, "same", BOARD),
	);
	expect(again).toMatchObject({ replay: true, receipt: once.receipt });
	expect(again.dispatch).toBeUndefined();
	expect(kanban.board(VIEW).runs).toHaveLength(1);
	await expect(
		store.write((tx) => kanban.runInTransaction(tx, input, rid(), BOARD)),
	).rejects.toThrow("revision_conflict");
	await expect(
		store.write((tx) =>
			kanban.runInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: view(a.cardId).revision },
				rid(),
				BOARD,
			),
		),
	).rejects.toThrow("kanban_card_busy");
});

test("a run needs a host that can track it, and a prompt that fits the request", async () => {
	const { store, kanban, card } = setup();
	const a = await card("A");
	await expect(
		store.write((tx) =>
			kanban.runInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: 1 },
				rid(),
				{ ...BOARD, runnable: false },
			),
		),
	).rejects.toThrow("kanban_not_runnable");
	// A prompt that could never be run is refused when it is saved, not when it is run.
	await expect(
		store.write((tx) =>
			kanban.addInTransaction(
				tx,
				{ title: "長い", prompt: "あ".repeat(KANBAN_PROMPT_MAX + 1) },
				rid(),
			),
		),
	).rejects.toThrow("kanban_prompt_too_long");
	const longest = await store.write((tx) =>
		kanban.addInTransaction(
			tx,
			{ title: "最長", prompt: "あ".repeat(KANBAN_PROMPT_MAX) },
			rid(),
		),
	);
	const sent = await store.write((tx) =>
		kanban.runInTransaction(
			tx,
			{ cardId: longest.receipt.cardId, expectedRevision: 1 },
			rid(),
			{ ...BOARD, runnable: true },
		),
	);
	expect(sent.dispatch!.prompt.length).toBeLessThanOrEqual(8000);
	// Only the accepted run was saved.
	expect(kanban.board(VIEW).runs).toHaveLength(1);
});

test("completion makes the card Done with the report and files, saves a notice and hands over the next run", async () => {
	const { kanban, card, view, run, finish } = setup();
	const a = await card("A");
	const b = await card("B");
	const one = await run(a.cardId);
	await run(b.cardId);
	const out = await finish(one.receipt.runId!);
	expect(out?.dispatch).toMatchObject({ cardId: b.cardId, kind: "task" });
	expect(view(a.cardId)).toMatchObject({
		column: "finished",
		label: "done",
		lastReport: "報告",
		files: ["a.ts"],
		reviewed: false,
		commitPushReported: false,
		followedByOtherRun: true,
		actions: [
			"edit",
			"remove",
			"run",
			"followup",
			"commitPush",
			"review",
			"reset",
			"open",
		],
	});
	expect(kanban.board(VIEW).queue.handedRunId).toBe(out!.dispatch!.runId);
	const { notices, unread } = await kanban.notices(10);
	expect(unread).toBe(1);
	expect(notices[0]).toMatchObject({
		kind: "done",
		cardId: a.cardId,
		text: "タスク『A』が終わりました",
		read: false,
	});
	// A late or repeated end of the same run changes nothing.
	expect(await finish(one.receipt.runId!, "unknown")).toBeNull();
	expect(view(a.cardId).label).toBe("done");
});

test("a run that did not complete is a Blocker with its reason; the queue goes on", async () => {
	const { kanban, card, view, run, finish } = setup();
	const a = await card("A");
	const b = await card("B");
	const one = await run(a.cardId);
	await run(b.cardId);
	const out = await finish(one.receipt.runId!, "interrupted");
	expect(view(a.cardId)).toMatchObject({
		column: "finished",
		label: "blocker",
		reason: "interrupted",
		actions: ["edit", "remove", "run", "followup", "reset", "open"],
	});
	expect(out?.dispatch?.cardId).toBe(b.cardId);
	expect((await kanban.notices(5)).notices[0]!.text).toBe(
		"タスク『A』が止まりました: 途中で止まりました",
	);
	expect(kanban.board(VIEW).queue.state).toBe("running");
});

test("blocker reasons follow the terminals reason; a lost or restarted run stops the queue", async () => {
	const { kanban, card, view, run, finish } = setup();
	const cases: Array<[KanbanRunFinish["state"], string | undefined, string]> = [
		["ended", undefined, "ended"],
		["ended", "resume_failed", "resume_failed"],
		["unknown", "stopped_by_person", "stopped_by_person"],
		["cancelled", "send_failed", "send_failed"],
		["unknown", undefined, "unknown"],
	];
	for (const [state, reason, expected] of cases) {
		const c = await card(`c-${expected}`);
		const r = await run(c.cardId);
		await finish(r.receipt.runId!, state, { reason });
		expect(view(c.cardId).reason).toBe(expected as never);
	}
	// The person's own stop is not announced.
	const kinds = (await kanban.notices(50)).notices.map((n) => n.text);
	expect(kinds.some((t) => t.includes("利用者が止めました"))).toBe(false);
	const lost = await card("L");
	const waiting = await card("W");
	const r = await run(lost.cardId);
	await run(waiting.cardId);
	const out = await finish(r.receipt.runId!, "unknown", {
		reason: "tracking_lost",
	});
	expect(out?.dispatch).toBeUndefined();
	expect(kanban.board(VIEW).queue).toEqual({
		state: "paused",
		reason: "tracking_lost",
		waiting: 1,
	});
	expect(view(lost.cardId)).toMatchObject({
		label: "blocker",
		reason: "tracking_lost",
		// A conversation that never reported cannot be continued: run again.
		actions: ["edit", "remove", "run", "reset", "open"],
	});
	const texts = (await kanban.notices(3)).notices.map((n) => n.text);
	expect(texts).toEqual([
		"実行キューが止まりました: 状態を追えないため止めました",
		"タスク『L』が止まりました: 状態を追えません（フックが届いていません）",
		expect.any(String),
	]);
});

test("resuming the queue hands over the oldest waiting run, and a run added while paused waits", async () => {
	const { store, kanban, card, run, finish } = setup();
	const a = await card("A");
	const b = await card("B");
	const one = await run(a.cardId);
	await finish(one.receipt.runId!, "unknown", { reason: "restarted" });
	expect(kanban.board(VIEW).queue.state).toBe("paused");
	const queued = await run(b.cardId);
	expect(queued.dispatch).toBeUndefined();
	const resumed = await store.write((tx) =>
		kanban.resumeQueueInTransaction(tx, rid()),
	);
	expect(resumed.receipt).toEqual({
		action: "queue_resumed",
		queue: "running",
	});
	expect(resumed.dispatch).toMatchObject({ runId: queued.receipt.runId });
	expect(kanban.board(VIEW).queue.state).toBe("running");
	// Resuming a running queue is harmless.
	const again = await store.write((tx) =>
		kanban.resumeQueueInTransaction(tx, rid()),
	);
	expect(again.dispatch).toBeUndefined();
});

test("a waiting run is cancelled into a Blocker; a handed one only while terminals has not sent it", async () => {
	const { store, kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const c = await card("C");
	await run(a.cardId);
	await run(b.cardId);
	const third = await run(c.cardId);
	const cancel = (cardId: string, unsent: boolean) =>
		store.write((tx) =>
			kanban.cancelInTransaction(
				tx,
				{ cardId, expectedRevision: view(cardId).revision },
				rid(),
				() => unsent,
			),
		);
	const waiting = await cancel(b.cardId, false);
	expect(waiting.receipt.action).toBe("cancelled");
	expect(waiting.dispatch).toBeUndefined();
	expect(view(b.cardId)).toMatchObject({
		label: "blocker",
		reason: "cancelled",
	});
	// Sent: refused, nothing changes.
	await expect(cancel(a.cardId, false)).rejects.toThrow("kanban_card_busy");
	expect(view(a.cardId).column).toBe("running");
	// Handed but unsent: cancelled, and the next waiting run takes the slot.
	const freed = await cancel(a.cardId, true);
	expect(freed.dispatch?.runId).toBe(third.receipt.runId!);
	// A person's cancel is not announced.
	expect((await kanban.notices(10)).notices).toEqual([]);
});

test("stop records the request until it is carried out; an unsent run is cancelled instead; unconfirmed stops the queue", async () => {
	const { store, kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const one = await run(a.cardId);
	await run(b.cardId);
	const stop = (cardId: string, unsent = false) =>
		store.write((tx) =>
			kanban.stopInTransaction(
				tx,
				{ cardId, expectedRevision: view(cardId).revision },
				rid(),
				() => unsent,
			),
		);
	const asked = await stop(a.cardId);
	expect(asked.receipt).toMatchObject({
		action: "stop_requested",
		runId: one.receipt.runId,
	});
	expect(await kanban.pendingStops()).toEqual([one.receipt.runId!]);
	// The card is still running until terminals writes the final state.
	expect(view(a.cardId).column).toBe("running");
	await kanban.stopUnconfirmed(one.receipt.runId!);
	expect(await kanban.pendingStops()).toEqual([]);
	expect(kanban.board(VIEW).queue).toMatchObject({
		state: "paused",
		reason: "stop_unconfirmed",
		handedRunId: one.receipt.runId,
	});
	// A waiting run is cancelled by "stop" as well.
	const waiting = await stop(b.cardId);
	expect(waiting.receipt.action).toBe("cancelled");
});

test("a follow-up continues the card's conversation in work mode; a note cannot make it commit", async () => {
	const { store, kanban, card, view, run, finish } = setup();
	const a = await card("A");
	const one = await run(a.cardId);
	await finish(one.receipt.runId!, "completed", { files: ["a.ts", "b.ts"] });
	const sessionId = view(a.cardId).claudeSessionId!;
	const follow = await store.write((tx) =>
		kanban.followupInTransaction(
			tx,
			{
				cardId: a.cardId,
				expectedRevision: view(a.cardId).revision,
				note: "commit して push まで",
			},
			rid(),
			CHAT,
		),
	);
	expect(follow.dispatch).toMatchObject({
		kind: "followup",
		target: "conversation",
		mode: "work",
		claudeSessionId: sessionId,
		origin: "conversation",
		conversationId: "main",
	});
	const body = follow.dispatch!.prompt;
	expect(body).toContain(
		`追加の依頼: ${JSON.stringify("commit して push まで")}`,
	);
	expect(body).toContain(`元の依頼: ${JSON.stringify("A の依頼")}`);
	expect(body).toContain(`前回の報告: ${JSON.stringify("報告")}`);
	expect(body.endsWith(WORK_ONLY_INSTRUCTION)).toBe(true);
	expect(view(a.cardId)).toMatchObject({
		column: "running",
		claudeSessionId: sessionId,
		files: ["a.ts", "b.ts"],
	});
	await finish(follow.dispatch!.runId, "completed", {
		lastReport: "追加分",
		files: ["b.ts", "c.ts"],
	});
	expect(view(a.cardId)).toMatchObject({
		label: "done",
		lastReport: "追加分",
		files: ["a.ts", "b.ts", "c.ts"],
		claudeSessionId: sessionId,
	});
});

test("a follow-up needs a finished card whose conversation exists", async () => {
	const { store, kanban, card, view, run } = setup();
	const todo = await card("T");
	const followup = (cardId: string) =>
		store.write((tx) =>
			kanban.followupInTransaction(
				tx,
				{ cardId, expectedRevision: view(cardId).revision, note: "続き" },
				rid(),
				BOARD,
			),
		);
	await expect(followup(todo.cardId)).rejects.toThrow("kanban_state_invalid");
	// A hand-made Done has no conversation.
	await store.write((tx) =>
		kanban.moveInTransaction(
			tx,
			{
				cardId: todo.cardId,
				expectedRevision: 1,
				column: "finished",
				beforeCardId: null,
			},
			rid(),
		),
	);
	await expect(followup(todo.cardId)).rejects.toThrow("kanban_state_invalid");
	// A run cancelled before it was sent has none either.
	const a = await card("A");
	await run(a.cardId);
	await store.write((tx) =>
		kanban.cancelInTransaction(
			tx,
			{ cardId: a.cardId, expectedRevision: view(a.cardId).revision },
			rid(),
			() => true,
		),
	);
	await expect(followup(a.cardId)).rejects.toThrow("kanban_state_invalid");
	expect(view(a.cardId).actions).not.toContain("followup");
	// Nothing was sent, so there is no session to open either.
	expect(view(a.cardId).actions).not.toContain("open");
	expect(kanban.board(VIEW).runs.filter((x) => x.kind === "followup")).toEqual(
		[],
	);
});

test("commit & push comes only from the board, on a Done card, with the recorded files", async () => {
	const { store, kanban, card, view, run, finish } = setup();
	const a = await card("A");
	const one = await run(a.cardId);
	await finish(one.receipt.runId!, "completed", {
		files: ["src/a.ts", "b.md"],
	});
	const commit = (context: typeof BOARD | typeof CHAT) =>
		store.write((tx) =>
			kanban.commitPushInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: view(a.cardId).revision },
				rid(),
				context,
			),
		);
	await expect(commit(CHAT)).rejects.toThrow("commit_push_requires_board");
	expect(view(a.cardId).column).toBe("finished");
	const out = await commit(BOARD);
	expect(out.dispatch).toMatchObject({
		kind: "commit_push",
		target: "conversation",
		mode: "commit",
		claudeSessionId: view(a.cardId).claudeSessionId,
	});
	expect(out.dispatch!.prompt).toContain('["src/a.ts","b.md"]');
	expect(out.dispatch!.prompt).not.toContain(WORK_ONLY_INSTRUCTION);
	await finish(out.dispatch!.runId, "completed", {
		lastReport: "pushed",
		files: [],
	});
	expect(view(a.cardId)).toMatchObject({
		label: "done",
		commitPushReported: true,
		lastReport: "pushed",
		files: ["src/a.ts", "b.md"],
		followedByOtherRun: false,
	});
	expect((await kanban.notices(1)).notices[0]).toMatchObject({
		kind: "commit_push",
		text: "タスク『A』の commit & push の報告があります",
	});
	// A Blocker cannot be committed.
	const b = await card("B");
	const rb = await run(b.cardId);
	await finish(rb.receipt.runId!, "interrupted");
	await expect(
		store.write((tx) =>
			kanban.commitPushInTransaction(
				tx,
				{ cardId: b.cardId, expectedRevision: view(b.cardId).revision },
				rid(),
				BOARD,
			),
		),
	).rejects.toThrow("kanban_state_invalid");
});

test("review marks a Done card; reset and moving to todo forget the runs; a rerun starts a new conversation", async () => {
	const { store, kanban, card, view, run, finish } = setup();
	const a = await card("A");
	const one = await run(a.cardId);
	await finish(one.receipt.runId!);
	const ref = () => ({
		cardId: a.cardId,
		expectedRevision: view(a.cardId).revision,
	});
	await store.write((tx) => kanban.reviewInTransaction(tx, ref(), rid()));
	expect(view(a.cardId)).toMatchObject({ reviewed: true });
	expect(view(a.cardId).actions).not.toContain("review");
	// Already reviewed: no new revision.
	const revision = view(a.cardId).revision;
	await store.write((tx) => kanban.reviewInTransaction(tx, ref(), rid()));
	expect(view(a.cardId).revision).toBe(revision);
	const oldSession = view(a.cardId).claudeSessionId;
	const again = await run(a.cardId);
	expect(again.dispatch!.claudeSessionId).not.toBe(oldSession);
	expect(view(a.cardId)).toMatchObject({
		reviewed: false,
		files: [],
		column: "running",
	});
	await finish(again.receipt.runId!, "interrupted");
	await store.write((tx) => kanban.resetInTransaction(tx, ref(), rid()));
	expect(view(a.cardId)).toMatchObject({
		column: "todo",
		files: [],
		actions: ["edit", "remove", "run"],
	});
	expect(view(a.cardId).claudeSessionId).toBeUndefined();
	expect(view(a.cardId).currentRunId).toBeUndefined();
	// Moving a finished card back to todo does the same.
	const b = await card("B");
	const rb = await run(b.cardId);
	await finish(rb.receipt.runId!);
	await store.write((tx) =>
		kanban.moveInTransaction(
			tx,
			{
				cardId: b.cardId,
				expectedRevision: view(b.cardId).revision,
				column: "todo",
				beforeCardId: null,
			},
			rid(),
		),
	);
	expect(view(b.cardId)).toMatchObject({ column: "todo", files: [] });
	expect(view(b.cardId).lastReport).toBeUndefined();
});

test("notices are newest first, countable as unread, readable once; a waiting run is announced once", async () => {
	const { store, kanban, card, run, finish } = setup();
	const a = await card("A");
	const one = await run(a.cardId);
	const runId = one.receipt.runId!;
	await store.write((tx) => kanban.waitingInTransaction(tx, runId));
	await store.write((tx) => kanban.waitingInTransaction(tx, runId));
	await finish(runId);
	const listed = await kanban.notices(10);
	expect(listed.notices.map((n) => n.kind)).toEqual(["done", "waiting"]);
	expect(listed.unread).toBe(2);
	expect(listed.notices[1]!.text).toBe("タスク『A』が許可を待っています");
	expect((await kanban.notices(1)).notices).toHaveLength(1);
	await kanban.readNotice(listed.notices[0]!.id);
	expect(await kanban.notices(10)).toMatchObject({ unread: 1 });
	expect((await kanban.notices(10)).notices[0]!.read).toBe(true);
	await expect(kanban.readNotice("missing")).rejects.toThrow(
		"kanban_notice_not_found",
	);
	// A finished run is not waiting any more.
	await store.write((tx) => kanban.waitingInTransaction(tx, runId));
	expect((await kanban.notices(10)).notices).toHaveLength(2);
});

test("recovery settles handed runs from their requests and stops the queue after a restart", async () => {
	const { kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const c = await card("C");
	await run(a.cardId);
	await run(b.cardId);
	await run(c.cardId);
	const handed: KanbanDispatch[] = [];
	await kanban.recover({
		// The request was lost (its table was reset): the run is unknown after the restart.
		request: () => null,
		enqueue: (_tx: Database, dispatch) => void handed.push(dispatch),
	});
	expect(view(a.cardId)).toMatchObject({
		label: "blocker",
		reason: "restarted",
	});
	expect(kanban.board(VIEW).queue).toMatchObject({
		state: "paused",
		reason: "restarted",
		waiting: 2,
	});
	expect(handed).toEqual([]);
});

test("recovery adopts a final request the listener missed and hands over what follows", async () => {
	const { kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const ra = await run(a.cardId);
	await run(b.cardId);
	const handed: KanbanDispatch[] = [];
	await kanban.recover({
		request: (_tx, runId) =>
			runId === ra.receipt.runId
				? { state: "completed", lastReport: "済", files: ["x.ts"] }
				: null,
		enqueue: (_tx, dispatch) => void handed.push(dispatch),
	});
	expect(view(a.cardId)).toMatchObject({ label: "done", lastReport: "済" });
	expect(handed.map((d) => d.cardId)).toEqual([b.cardId]);
	// An open request is left alone.
	await kanban.recover({
		request: () => ({ state: "started", files: [] }),
		enqueue: () => {
			throw new Error("not expected");
		},
	});
	expect(view(b.cardId).column).toBe("running");
});

test("board runs keep the open ones and each card's current run", async () => {
	const { kanban, card, run, finish, store } = setup();
	const a = await card("A");
	const r1 = await run(a.cardId);
	await finish(r1.receipt.runId!);
	const r2 = await run(a.cardId);
	await finish(r2.receipt.runId!);
	const board = kanban.board(VIEW);
	expect(board.runs.map((r) => r.id)).toEqual([r2.receipt.runId!]);
	expect(first(board.runs)).toMatchObject({ state: "completed", title: "A" });
	const count = (store as SqliteStore).read(
		(db) =>
			(db.query("SELECT COUNT(*) AS n FROM kanban_runs").get() as { n: number })
				.n,
	);
	// The history stays in the table.
	expect(count).toBe(2);
});

test("reconcile settles a handed run from its final request, hands over what follows, and leaves the rest alone", async () => {
	const { kanban, card, view, run } = setup();
	const a = await card("A");
	const b = await card("B");
	const ra = (await run(a.cardId)).receipt.runId;
	await run(b.cardId);
	const handed: KanbanDispatch[] = [];
	const ports = (state: string | null) => ({
		request: (_tx: Database, runId: string) =>
			state && runId === ra
				? { state, files: ["x.ts"], lastReport: "済" }
				: null,
		enqueue: (_tx: Database, dispatch: KanbanDispatch) =>
			void handed.push(dispatch),
	});
	// An open request and a missing request are not this method's business (recovery's is).
	expect(await kanban.reconcile(ports("started"))).toBe(0);
	expect(await kanban.reconcile(ports(null))).toBe(0);
	expect(view(a.cardId).column).toBe("running");
	// Always going to the writer finds nothing to do either.
	expect(await kanban.reconcile(ports("started"), { always: true })).toBe(0);

	expect(await kanban.reconcile(ports("completed"))).toBe(1);
	expect(view(a.cardId)).toMatchObject({
		label: "done",
		lastReport: "済",
		files: ["x.ts"],
	});
	expect(handed.map((d) => d.cardId)).toEqual([b.cardId]);
	// Settled once: asking again changes nothing.
	handed.length = 0;
	expect(await kanban.reconcile(ports("completed"))).toBe(0);
	expect(handed).toEqual([]);
});

test("reconcile turns a request that ended without completing into a Blocker", async () => {
	const { kanban, card, view, run } = setup();
	const a = await card("A");
	await run(a.cardId);
	await kanban.reconcile({
		request: () => ({
			state: "unknown",
			reason: "stopped_by_person",
			files: [],
		}),
		enqueue: () => {},
	});
	expect(view(a.cardId)).toMatchObject({
		label: "blocker",
		reason: "stopped_by_person",
	});
	expect(kanban.board(VIEW).queue.state).toBe("running");
});
