import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	createKanban,
	kanbanReceiptSchema,
	migrations as kanbanMigrations,
	type KanbanBoardView,
} from "../domains/kanban";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import {
	createKanbanAdapter,
	describeKanbanAdapter,
	kanbanDomainSchemas,
	KANBAN_ADAPTER_REF,
} from "./kanban-adapter";
import { connectKanbanRuns } from "./kanban-runs";
import { migrations } from "./migrations";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type Enqueued = import("../domains/terminals").EnqueueRequest;
/** A terminals stand-in that records what is handed over and answers the board's questions. */
function fakeTerminals() {
	const state = {
		enqueued: [] as Enqueued[],
		unsent: false,
		failEnqueue: undefined as string | undefined,
		stops: [] as string[],
		stopResult: "stopped" as "stopped" | "unconfirmed",
		requests: new Map<string, { state: string }>(),
		sessions: [] as ReturnType<TerminalsPort["activities"]>,
	};
	const terminals = {
		enqueueInTransaction(_tx: Database, request: Enqueued) {
			if (state.failEnqueue) throw new Error(state.failEnqueue);
			state.enqueued.push(request);
			return {} as never;
		},
		cancelQueuedInTransaction: () => state.unsent,
		requestInTransaction: (_tx: Database, id: string) =>
			(state.requests.get(id) as never) ?? null,
		stop: async (id: string) => {
			state.stops.push(id);
			return state.stopResult;
		},
		activities: () => state.sessions,
		onFinishedInTransaction: () => () => {},
		onWaitingInTransaction: () => () => {},
	} satisfies TerminalsPort;
	return { terminals, state };
}
type TerminalsPort = import("./kanban-runs").KanbanTerminals;

function setup(runnable = true) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-kanban-adapter-"));
	dirs.push(dir);
	// The app migration list does not include kanban until the host registers it.
	const store = openStore(join(dir, "db"), [
		...migrations,
		...kanbanMigrations.filter(
			(kanban) => !migrations.some((m) => m.id === kanban.id),
		),
	]);
	stores.push(store);
	let seq = 0;
	const kanban = createKanban({
		store,
		id: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
	});
	const state = { runnable };
	const fake = fakeTerminals();
	connectKanbanRuns(kanban, fake.terminals);
	const adapter = createKanbanAdapter(kanban, {
		runnable: () => state.runnable,
	});
	return { store, adapter, state, kanban, fake };
}

const origin = { kind: "ui" as const, scope: "s", actionRequestId: "a" };
let n = 0;
const invoke = (
	tx: Database,
	adapter: ReturnType<typeof setup>["adapter"],
	operationName: string,
	input: unknown,
	requestId = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
) =>
	adapter.invokeInTransaction(tx, {
		operationName,
		input,
		requestId,
		issuedAt: "2026-10-14T00:00:00.000Z",
		origin,
	});
const board = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
) =>
	store.read((tx) =>
		adapter.sourceInTransaction(tx, "query:kanban.board@1", undefined)!,
	);

test("describes the operations, board query, input adapters and projection", () => {
	const described = describeKanbanAdapter();
	expect(described.owner).toBe("kanban");
	expect(
		Object.fromEntries(
			[...described.operations].map(([name, op]) => [
				name,
				`${op.inputSchemaRef}:${op.effect}`,
			]),
		),
	).toEqual({
		"kanban.add": "builtin:kanbanAdd:write",
		"kanban.edit": "builtin:kanbanEdit:write",
		"kanban.move": "builtin:kanbanMove:write",
		"kanban.remove": "builtin:kanbanCardRef:write",
		"kanban.run": "builtin:kanbanCardRef:write",
		"kanban.followup": "builtin:kanbanFollowup:write",
		"kanban.commit-push": "builtin:kanbanCardRef:write",
		"kanban.review": "builtin:kanbanCardRef:write",
		"kanban.cancel": "builtin:kanbanCardRef:write",
		"kanban.stop": "builtin:kanbanCardRef:write",
		"kanban.reset": "builtin:kanbanCardRef:write",
		"kanban.resume-queue": "builtin:kanbanList:write",
	});
	expect([...described.queries]).toEqual(["query:kanban.board@1"]);
	expect([...described.inputAdapters.keys()].sort()).toEqual([
		"input:kanban.add@1",
		"input:kanban.card@1",
		"input:kanban.edit@1",
		"input:kanban.followup@1",
		"input:kanban.move@1",
	]);
	expect([...described.projections]).toEqual(["projection:kanban.result@1"]);
	expect(described.availability).toBe("availability:kanban@1");
	expect(Object.keys(kanbanDomainSchemas)).toEqual(["domain:kanban.receipt@1"]);
	expect(KANBAN_ADAPTER_REF).toBe("adapter:kanban@1");
});

test("operations change the board and the board source carries revision and runnable", async () => {
	const { store, adapter, state } = setup();
	expect(board(store, adapter)).toEqual({
		revision: 0,
		data: {
			revision: 0,
			queue: { state: "running", waiting: 0 },
			runnable: true,
			cards: [],
			runs: [],
		},
	});
	const added = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", { title: "A", prompt: "依頼" }),
	);
	expect(
		kanbanDomainSchemas["domain:kanban.receipt@1"].parse(added.receipt),
	).toEqual(added.receipt as never);
	expect(added).toMatchObject({
		replay: false,
		receipt: { action: "added", revision: 1, title: "A", column: "todo" },
		receiptRef: { owner: "kanban" },
		resultRefs: [
			{ owner: "kanban", kind: "card", schemaRef: "domain:kanban.receipt@1" },
		],
	});
	const cardId = (added.receipt as { cardId: string }).cardId;
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.edit", {
			cardId,
			expectedRevision: 1,
			title: "A2",
		}),
	);
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.move", {
			cardId,
			expectedRevision: 2,
			column: "finished",
			beforeCardId: null,
		}),
	);
	const moved = board(store, adapter);
	const data = moved.data as KanbanBoardView;
	expect(moved.revision).toBe(3);
	expect(data.cards[0]).toMatchObject({
		title: "A2",
		column: "finished",
		label: "done",
		revision: 3,
		actions: ["edit", "remove", "run", "review", "reset", "open"],
	});
	state.runnable = false;
	expect((board(store, adapter).data as KanbanBoardView).runnable).toBe(false);
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.remove", { cardId, expectedRevision: 3 }),
	);
	expect((board(store, adapter).data as KanbanBoardView).cards).toEqual([]);
});

test("rejections and a stale revision change nothing; the source is only the untargeted board", async () => {
	const { store, adapter } = setup();
	const added = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", { title: "A", prompt: "依頼" }),
	);
	const cardId = (added.receipt as { cardId: string }).cardId;
	const before = board(store, adapter);
	await expect(
		store.write((tx) =>
			invoke(tx, adapter, "kanban.edit", {
				cardId,
				expectedRevision: 9,
				title: "X",
			}),
		),
	).rejects.toThrow("revision_conflict");
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.add", { title: "" })),
	).rejects.toThrow();
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.unknown", {})),
	).rejects.toThrow("capability_unavailable");
	expect(board(store, adapter)).toEqual(before);
	store.read((tx) => {
		expect(
			adapter.sourceInTransaction(tx, "query:kanban.board@1", "x"),
		).toBeNull();
		expect(
			adapter.sourceInTransaction(tx, "query:other@1", undefined),
		).toBeNull();
	});
});

test("the same request id replays and can be read back", async () => {
	const { store, adapter } = setup();
	const input = { title: "A", prompt: "依頼" };
	const first = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", input, "req-1"),
	);
	const again = await store.write((tx) =>
		invoke(tx, adapter, "kanban.add", input, "req-1"),
	);
	expect(again.replay).toBe(true);
	expect(again.receipt).toEqual(first.receipt);
	expect(again.receiptRef).toEqual(first.receiptRef);
	const read = store.read((tx) => adapter.readInTransaction(tx, "req-1"));
	expect(read).toMatchObject({ replay: true, receipt: first.receipt });
	expect(kanbanReceiptSchema.parse(read?.receipt)).toEqual(
		first.receipt as never,
	);
	expect(
		store.read((tx) => adapter.readInTransaction(tx, "missing")),
	).toBeNull();
	expect((board(store, adapter).data as KanbanBoardView).cards).toHaveLength(1);
	expect(store.read((tx) => adapter.snapshotInTransaction(tx))).toEqual({
		cards: [
			expect.objectContaining({ title: "A", column: "todo", revision: 1 }),
		],
	});
});

test("input adapters turn the event strings into typed inputs and reject bad values", () => {
	const { inputAdapters } = describeKanbanAdapter();
	const run = (ref: string, raw: Record<string, unknown>) =>
		inputAdapters.get(ref)!(raw);
	const id = "00000000-0000-4000-8000-000000000001";
	expect(run("input:kanban.add@1", { title: "A", prompt: "P" })).toEqual({
		ok: true,
		value: { title: "A", prompt: "P" },
	});
	expect(
		run("input:kanban.edit@1", { cardId: id, expectedRevision: "12" }),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 12 },
	});
	expect(
		run("input:kanban.edit@1", {
			cardId: id,
			expectedRevision: "2",
			title: "T",
			prompt: "P",
		}),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 2, title: "T", prompt: "P" },
	});
	expect(
		run("input:kanban.move@1", {
			cardId: id,
			expectedRevision: "3",
			column: "finished",
			beforeCardId: "",
		}),
	).toEqual({
		ok: true,
		value: {
			cardId: id,
			expectedRevision: 3,
			column: "finished",
			beforeCardId: null,
		},
	});
	expect(
		run("input:kanban.move@1", {
			cardId: id,
			expectedRevision: "3",
			column: "todo",
			beforeCardId: id,
		}),
	).toMatchObject({ ok: true, value: { beforeCardId: id } });
	expect(
		run("input:kanban.card@1", { cardId: id, expectedRevision: "1" }),
	).toEqual({
		ok: true,
		value: { cardId: id, expectedRevision: 1 },
	});
	expect(
		run("input:kanban.move@1", {
			cardId: "",
			expectedRevision: "0",
			column: "running",
		}),
	).toEqual({
		ok: false,
		errors: [
			{ field: "cardId", message: "カードを指定してください" },
			{ field: "expectedRevision", message: "revision を確認してください" },
			{ field: "column", message: "移動先を確認してください" },
			{ field: "beforeCardId", message: "位置を確認してください" },
		],
	});
	expect(
		run("input:kanban.edit@1", {
			cardId: id,
			expectedRevision: "1",
			title: " ",
		}),
	).toEqual({
		ok: false,
		errors: [{ field: "title", message: "入力してください" }],
	});
	expect(run("input:kanban.add@1", { title: "A" })).toEqual({
		ok: false,
		errors: [{ field: "prompt", message: "入力してください" }],
	});
});

const addCard = async (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
	title: string,
) =>
	(
		(
			await store.write((tx) =>
				invoke(tx, adapter, "kanban.add", { title, prompt: `${title} の依頼` }),
			)
		).receipt as { cardId: string }
	).cardId;
const boardData = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
) => board(store, adapter).data as KanbanBoardView;
const revisionOf = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
	cardId: string,
) => boardData(store, adapter).cards.find((c) => c.id === cardId)!.revision;
const conversation = {
	kind: "conversation" as const,
	owner: {} as never,
	runId: "r",
	conversationId: "main",
	messageId: "m",
};

test("run hands the first run to terminals in the same transaction, once, as the card's kanban owner", async () => {
	const { store, adapter, fake } = setup();
	const a = await addCard(store, adapter, "A");
	const b = await addCard(store, adapter, "B");
	const ref = (cardId: string) => ({
		cardId,
		expectedRevision: revisionOf(store, adapter, cardId),
	});
	const first = await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", ref(a), "run-1"),
	);
	expect(first).toMatchObject({
		replay: false,
		receipt: { action: "run", cardId: a, column: "running" },
		answerContext: { queued: true },
	});
	expect(fake.state.enqueued).toHaveLength(1);
	expect(fake.state.enqueued[0]).toMatchObject({
		owner: `kanban:${a}`,
		exclusiveGroup: "kanban",
		target: "new",
		mode: "work",
		projectId: "eumenes",
		task: "A",
		origin: "board",
		attemptId: (first.receipt as { runId: string }).runId,
	});
	expect(fake.state.enqueued[0]!.prompt).toContain("git commit と git push をしない");
	// The second run waits for its turn; the same request again replays and sends nothing.
	await store.write((tx) => invoke(tx, adapter, "kanban.run", ref(b)));
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }, "run-1"),
	);
	expect(fake.state.enqueued).toHaveLength(1);
	expect(boardData(store, adapter).queue).toMatchObject({ waiting: 1 });
});

test("a run terminals cannot take (tracking) is refused and nothing is saved", async () => {
	const { store, adapter, fake } = setup();
	const a = await addCard(store, adapter, "A");
	const before = board(store, adapter);
	fake.state.failEnqueue = "terminal_tracking_unavailable";
	await expect(
		store.write((tx) =>
			invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
		),
	).rejects.toThrow("terminal_tracking_unavailable");
	expect(board(store, adapter)).toEqual(before);
});

test("commit & push is created only by the board's button, in commit mode", async () => {
	const { store, adapter, fake, kanban } = setup();
	const a = await addCard(store, adapter, "A");
	const run = await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
	);
	await store.write((tx) =>
		kanban.finishRunInTransaction(tx, {
			runId: (run.receipt as { runId: string }).runId,
			state: "completed",
			lastReport: "終わり",
			files: ["a.ts"],
		}),
	);
	const ref = () => ({ cardId: a, expectedRevision: revisionOf(store, adapter, a) });
	await expect(
		store.write((tx) =>
			adapter.invokeInTransaction(tx, {
				operationName: "kanban.commit-push",
				input: ref(),
				requestId: "chat-commit",
				issuedAt: "2026-10-14T00:00:00.000Z",
				origin: conversation,
			}),
		),
	).rejects.toThrow("commit_push_requires_board");
	expect(fake.state.enqueued).toHaveLength(1);
	await store.write((tx) => invoke(tx, adapter, "kanban.commit-push", ref()));
	expect(fake.state.enqueued[1]).toMatchObject({
		target: "conversation",
		mode: "commit",
		owner: `kanban:${a}`,
	});
	expect(fake.state.enqueued[1]!.prompt).toContain('["a.ts"]');
	// The run of a conversation is attributed to it.
	const b = await addCard(store, adapter, "B");
	await store.write((tx) =>
		adapter.invokeInTransaction(tx, {
			operationName: "kanban.run",
			input: { cardId: b, expectedRevision: 1 },
			requestId: "chat-run",
			issuedAt: "2026-10-14T00:00:00.000Z",
			origin: conversation,
		}),
	);
	expect(boardData(store, adapter).runs.at(-1)).toMatchObject({
		origin: "conversation",
	});
});

test("cancel hands the unsent request back to terminals; a sent one is refused", async () => {
	const { store, adapter, fake } = setup();
	const a = await addCard(store, adapter, "A");
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
	);
	const ref = () => ({ cardId: a, expectedRevision: revisionOf(store, adapter, a) });
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.cancel", ref())),
	).rejects.toThrow("kanban_card_busy");
	fake.state.unsent = true;
	const out = await store.write((tx) =>
		invoke(tx, adapter, "kanban.cancel", ref()),
	);
	expect(out.receipt).toMatchObject({ action: "cancelled", column: "finished" });
});

test("the board shows each handed run's request state and activity; an unsent run offers cancel", async () => {
	const { store, adapter, fake } = setup();
	const a = await addCard(store, adapter, "A");
	const run = await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
	);
	const runId = (run.receipt as { runId: string }).runId;
	fake.state.requests.set(runId, { state: "queued" });
	let data = boardData(store, adapter);
	expect(data.runs[0]).toMatchObject({ requestState: "queued" });
	expect(data.runs[0]!.activity).toBeUndefined();
	expect(data.cards[0]!.actions).toEqual(["cancel", "open"]);
	fake.state.requests.set(runId, { state: "started" });
	fake.state.sessions = [
		{
			terminalSessionId: "t1",
			owner: `kanban:${a}`,
			mode: "work",
			claudeSessionId: data.runs[0]!.claudeSessionId,
			status: "running",
			activity: "waiting",
		},
	];
	data = boardData(store, adapter);
	expect(data.runs[0]).toMatchObject({
		requestState: "started",
		activity: "waiting",
	});
	expect(data.cards[0]!.actions).toEqual(["stop", "open"]);
});

test("stop is carried out after commit; an unconfirmed stop pauses the queue; resume sends the queue on", async () => {
	const { store, adapter, fake, kanban } = setup();
	const a = await addCard(store, adapter, "A");
	const b = await addCard(store, adapter, "B");
	const run = await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
	);
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: b, expectedRevision: 1 }),
	);
	const runId = (run.receipt as { runId: string }).runId;
	const stopped = await store.write((tx) =>
		invoke(tx, adapter, "kanban.stop", {
			cardId: a,
			expectedRevision: revisionOf(store, adapter, a),
		}),
	);
	expect(stopped.receipt).toMatchObject({ action: "stop_requested" });
	// Nothing runs before the transaction is committed.
	expect(fake.state.stops).toEqual([]);
	fake.state.stopResult = "unconfirmed";
	adapter.afterCommit!();
	adapter.afterCommit!();
	await Bun.sleep(30);
	expect(fake.state.stops).toEqual([runId]);
	expect(boardData(store, adapter).queue).toMatchObject({
		state: "paused",
		reason: "stop_unconfirmed",
		handedRunId: runId,
	});
	// The stuck run ends later; the queue stays paused until the person resumes it.
	await store.write((tx) =>
		kanban.finishRunInTransaction(tx, {
			runId,
			state: "ended",
			lastReport: "",
			files: [],
		}),
	);
	expect(fake.state.enqueued).toHaveLength(1);
	const resumed = await store.write((tx) =>
		invoke(tx, adapter, "kanban.resume-queue", {}),
	);
	expect(resumed.receipt).toEqual({ action: "queue_resumed", queue: "running" });
	expect(kanbanReceiptSchema.parse(resumed.receipt)).toEqual(resumed.receipt as never);
	expect(fake.state.enqueued.map((r) => r.owner)).toEqual([
		`kanban:${a}`,
		`kanban:${b}`,
	]);
});

test("follow-up, review and reset go through the domain; the follow-up input adapter reads the note", async () => {
	const { store, adapter, kanban, fake } = setup();
	const a = await addCard(store, adapter, "A");
	const run = await store.write((tx) =>
		invoke(tx, adapter, "kanban.run", { cardId: a, expectedRevision: 1 }),
	);
	await store.write((tx) =>
		kanban.finishRunInTransaction(tx, {
			runId: (run.receipt as { runId: string }).runId,
			state: "completed",
			lastReport: "終わり",
			files: [],
		}),
	);
	const ref = () => ({ cardId: a, expectedRevision: revisionOf(store, adapter, a) });
	const { inputAdapters } = describeKanbanAdapter();
	expect(
		inputAdapters.get("input:kanban.followup@1")!({
			cardId: a,
			expectedRevision: "3",
			note: "もう少し",
		}),
	).toEqual({ ok: true, value: { cardId: a, expectedRevision: 3, note: "もう少し" } });
	expect(
		inputAdapters.get("input:kanban.followup@1")!({
			cardId: a,
			expectedRevision: "3",
		}),
	).toMatchObject({ ok: false });
	await store.write((tx) => invoke(tx, adapter, "kanban.review", ref()));
	await store.write((tx) =>
		invoke(tx, adapter, "kanban.followup", { ...ref(), note: "もう少し" }),
	);
	expect(fake.state.enqueued[1]).toMatchObject({
		target: "conversation",
		mode: "work",
		claudeSessionId: fake.state.enqueued[0]!.claudeSessionId,
	});
	await expect(
		store.write((tx) => invoke(tx, adapter, "kanban.reset", ref())),
	).rejects.toThrow("kanban_card_busy");
});
