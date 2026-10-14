import { expect, test } from "bun:test";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createKanban, migrations, type KanbanService } from "..";
import { openKanban, stores } from "./kanban.fixture";

let req = 0;
const rid = () => `req-${++req}`;
const VIEW = { runnable: true };

async function add(
	store: SqliteStore,
	kanban: KanbanService,
	title: string,
	beforeCardId?: string | null,
) {
	const { receipt } = await store.write((tx) =>
		kanban.addInTransaction(
			tx,
			{ title, prompt: `${title} の依頼`, beforeCardId },
			rid(),
		),
	);
	return receipt;
}
const titles = (kanban: KanbanService, column: string) =>
	kanban
		.board(VIEW)
		.cards.filter((card) => card.column === column)
		.map((card) => card.title);

test("add appends to todo, and inserts before a card with beforeCardId", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	await add(store, kanban, "B");
	await add(store, kanban, "C", a.cardId);
	expect(titles(kanban, "todo")).toEqual(["C", "A", "B"]);
	const board = kanban.board(VIEW);
	expect(board.cards.map((card) => card.position)).toEqual([0, 1, 2]);
	expect(board.cards[0]).toMatchObject({
		revision: 1,
		projectId: "eumenes",
		reviewed: false,
		files: [],
	});
	expect(board.revision).toBe(3);
	expect(board.queue).toEqual({ state: "running", waiting: 0 });
	expect(board.runs).toEqual([]);
});

test("add rejects an unknown or foreign beforeCardId and saves nothing", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	await store.write((tx) =>
		kanban.moveInTransaction(
			tx,
			{
				cardId: a.cardId,
				expectedRevision: a.revision,
				column: "finished",
				beforeCardId: null,
			},
			rid(),
		),
	);
	await expect(
		add(store, kanban, "B", "00000000-0000-4000-8000-0000000000ff"),
	).rejects.toThrow("kanban_card_not_found");
	await expect(add(store, kanban, "B", a.cardId)).rejects.toThrow(
		"kanban_column_invalid",
	);
	expect(kanban.board(VIEW).cards).toHaveLength(1);
});

test("edit bumps the revision; an unchanged edit does not", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	const edited = await store.write((tx) =>
		kanban.editInTransaction(
			tx,
			{ cardId: a.cardId, expectedRevision: 1, title: "A2" },
			rid(),
		),
	);
	expect(edited.receipt).toMatchObject({
		action: "edited",
		revision: 2,
		title: "A2",
	});
	const before = kanban.board(VIEW);
	const same = await store.write((tx) =>
		kanban.editInTransaction(
			tx,
			{ cardId: a.cardId, expectedRevision: 2, title: "A2" },
			rid(),
		),
	);
	expect(same.receipt.revision).toBe(2);
	expect(kanban.board(VIEW).revision).toBe(before.revision);
	expect(before.cards[0]?.prompt).toBe("A の依頼");
});

test("a stale expectedRevision is revision_conflict and nothing changes", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	await store.write((tx) =>
		kanban.editInTransaction(
			tx,
			{ cardId: a.cardId, expectedRevision: 1, prompt: "新しい依頼" },
			rid(),
		),
	);
	const board = kanban.board(VIEW);
	for (const run of [
		(tx: import("bun:sqlite").Database) =>
			kanban.editInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: 1, title: "X" },
				rid(),
			),
		(tx: import("bun:sqlite").Database) =>
			kanban.moveInTransaction(
				tx,
				{
					cardId: a.cardId,
					expectedRevision: 1,
					column: "finished",
					beforeCardId: null,
				},
				rid(),
			),
		(tx: import("bun:sqlite").Database) =>
			kanban.removeInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: 1 },
				rid(),
			),
	])
		await expect(store.write(run)).rejects.toThrow("revision_conflict");
	expect(kanban.board(VIEW)).toEqual(board);
	await expect(
		store.write((tx) =>
			kanban.editInTransaction(
				tx,
				{
					cardId: "00000000-0000-4000-8000-0000000000ff",
					expectedRevision: 1,
					title: "X",
				},
				rid(),
			),
		),
	).rejects.toThrow("kanban_card_not_found");
});

test("move reorders within a column and between columns; Done is the label of finished", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	const b = await add(store, kanban, "B");
	const c = await add(store, kanban, "C");
	const move = (
		card: { cardId: string },
		revision: number,
		column: "todo" | "finished",
		beforeCardId: string | null,
	) =>
		store.write((tx) =>
			kanban.moveInTransaction(
				tx,
				{
					cardId: card.cardId,
					expectedRevision: revision,
					column,
					beforeCardId,
				},
				rid(),
			),
		);
	// C before A, then A to the end, then B to Done.
	await move(c, 1, "todo", a.cardId);
	expect(titles(kanban, "todo")).toEqual(["C", "A", "B"]);
	await move(a, 1, "todo", null);
	expect(titles(kanban, "todo")).toEqual(["C", "B", "A"]);
	const moved = await move(b, 1, "finished", null);
	expect(moved.receipt).toMatchObject({ column: "finished", revision: 2 });
	expect(titles(kanban, "todo")).toEqual(["C", "A"]);
	const board = kanban.board(VIEW);
	expect(board.cards.find((card) => card.id === b.cardId)).toMatchObject({
		column: "finished",
		label: "done",
		position: 0,
	});
	expect(
		board.cards.filter((card) => card.column === "todo").map((c) => c.position),
	).toEqual([0, 1]);
	// Before itself keeps the place; back to todo clears the label.
	await move(c, 2, "todo", c.cardId);
	expect(titles(kanban, "todo")).toEqual(["C", "A"]);
	await move(b, 2, "todo", a.cardId);
	expect(titles(kanban, "todo")).toEqual(["C", "B", "A"]);
	expect(
		kanban.board(VIEW).cards.find((card) => card.id === b.cardId)?.label,
	).toBeUndefined();
	// Moving before itself into another column is invalid.
	await expect(move(a, 2, "finished", a.cardId)).rejects.toThrow(
		"kanban_column_invalid",
	);
});

test("remove deletes the card and closes the gap", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	await add(store, kanban, "B");
	const removed = await store.write((tx) =>
		kanban.removeInTransaction(
			tx,
			{ cardId: a.cardId, expectedRevision: 1 },
			rid(),
		),
	);
	expect(removed.receipt).toMatchObject({ action: "removed", title: "A" });
	const board = kanban.board(VIEW);
	expect(board.cards.map((card) => [card.title, card.position])).toEqual([
		["B", 0],
	]);
	expect(
		store.read((tx) => kanban.cardInTransaction(tx, a.cardId, VIEW)),
	).toBeNull();
});

test("the same request id replays the saved receipt; a different input is request_conflict", async () => {
	const { store, kanban } = openKanban();
	const input = { title: "A", prompt: "依頼" };
	const first = await store.write((tx) =>
		kanban.addInTransaction(tx, input, "same"),
	);
	const again = await store.write((tx) =>
		kanban.addInTransaction(tx, input, "same"),
	);
	expect(first.replay).toBe(false);
	expect(again).toEqual({ receipt: first.receipt, replay: true });
	expect(kanban.board(VIEW).cards).toHaveLength(1);
	await expect(
		store.write((tx) =>
			kanban.addInTransaction(tx, { ...input, title: "B" }, "same"),
		),
	).rejects.toThrow("request_conflict");
	await expect(
		store.write((tx) =>
			kanban.removeInTransaction(
				tx,
				{ cardId: first.receipt.cardId, expectedRevision: 1 },
				"same",
			),
		),
	).rejects.toThrow("request_conflict");
	// A replayed remove still answers after the card is gone.
	await store.write((tx) =>
		kanban.removeInTransaction(
			tx,
			{ cardId: first.receipt.cardId, expectedRevision: 1 },
			"rm",
		),
	);
	const replay = await store.write((tx) =>
		kanban.removeInTransaction(
			tx,
			{ cardId: first.receipt.cardId, expectedRevision: 1 },
			"rm",
		),
	);
	expect(replay.replay).toBe(true);
	expect(store.read((tx) => kanban.receiptInTransaction(tx, "rm"))).toEqual(
		replay.receipt,
	);
	expect(
		store.read((tx) => kanban.receiptInTransaction(tx, "none")),
	).toBeNull();
});

test("actions are decided by the domain from the column and runnable", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	expect(kanban.board(VIEW).cards[0]?.actions).toEqual([
		"edit",
		"remove",
		"run",
	]);
	const stopped = kanban.board({ runnable: false });
	expect(stopped.runnable).toBe(false);
	expect(stopped.cards[0]?.actions).toEqual(["edit", "remove"]);
	await store.write((tx) =>
		kanban.moveInTransaction(
			tx,
			{
				cardId: a.cardId,
				expectedRevision: 1,
				column: "finished",
				beforeCardId: null,
			},
			rid(),
		),
	);
	expect(kanban.board(VIEW).cards[0]?.actions).toEqual([
		"edit",
		"remove",
		"run",
		"review",
		"reset",
	]);
});

test("a running card cannot be edited, moved or removed", async () => {
	const { store, kanban } = openKanban();
	const a = await add(store, kanban, "A");
	await store.write((tx) =>
		tx
			.query(
				"UPDATE kanban_cards SET column_name='running', label=NULL WHERE id=?",
			)
			.run(a.cardId),
	);
	expect(kanban.board(VIEW).cards[0]?.actions).toEqual(["stop", "open"]);
	for (const run of [
		(tx: import("bun:sqlite").Database) =>
			kanban.editInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: 1, title: "X" },
				rid(),
			),
		(tx: import("bun:sqlite").Database) =>
			kanban.moveInTransaction(
				tx,
				{
					cardId: a.cardId,
					expectedRevision: 1,
					column: "todo",
					beforeCardId: null,
				},
				rid(),
			),
		(tx: import("bun:sqlite").Database) =>
			kanban.removeInTransaction(
				tx,
				{ cardId: a.cardId, expectedRevision: 1 },
				rid(),
			),
	])
		await expect(store.write(run)).rejects.toThrow("kanban_card_busy");
});

test("cards and order survive reopening the database", async () => {
	const { store, kanban, file } = openKanban();
	await add(store, kanban, "A");
	await add(store, kanban, "B");
	const before = kanban.board(VIEW);
	await store.close();
	stores.length = 0;
	const reopened = openStore(file, [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	stores.push(reopened);
	expect(createKanban({ store: reopened }).board(VIEW)).toEqual(before);
});
