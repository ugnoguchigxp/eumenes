import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { boardInTransaction } from "../board";
import { openKanban } from "./kanban.fixture";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-14T00:00:00.000Z");
const BOARD = { origin: "board" as const, runnable: true };
let req = 0;
const rid = () => `ret-req-${++req}`;

function setup() {
	const { store, kanban } = openKanban();
	const view = () => kanban.board({ runnable: true });
	const add = async (title: string) =>
		(
			await store.write((tx) =>
				kanban.addInTransaction(
					tx,
					{ title, prompt: `${title} の依頼` },
					rid(),
				),
			)
		).receipt.cardId;
	const run = async (cardId: string) =>
		(
			await store.write((tx) =>
				kanban.runInTransaction(
					tx,
					{
						cardId,
						expectedRevision: view().cards.find((c) => c.id === cardId)!
							.revision,
					},
					rid(),
					BOARD,
				),
			)
		).receipt.runId!;
	const finish = (runId: string) =>
		store.write((tx) =>
			kanban.finishRunInTransaction(tx, {
				runId,
				state: "completed",
				lastReport: "報告",
				files: [],
			}),
		);
	const count = (table: string) =>
		store.read(
			(db) =>
				(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
					.n,
		);
	return { store, kanban, view, add, run, finish, count };
}

test("pruning deletes final runs and receipts older than 30 days, never a current or open run", async () => {
	const { store, kanban, view, add, run, finish, count } = setup();
	const a = await add("A");
	const b = await add("B");
	const c = await add("C");
	const oldRun = await run(a);
	await finish(oldRun);
	const current = await run(b);
	await finish(current);
	// C is handed (open): its run has no final state yet.
	const open = await run(c);
	// A goes back to todo: its finished run stays only as history.
	await store.write((tx) =>
		kanban.resetInTransaction(
			tx,
			{
				cardId: a,
				expectedRevision: view().cards.find((x) => x.id === a)!.revision,
			},
			rid(),
		),
	);
	const runsBefore = count("kanban_runs");
	const receiptsBefore = count("kanban_receipts");
	expect(runsBefore).toBe(3);

	// Nothing is old yet.
	expect(
		await store.write((tx) => kanban.pruneInTransaction(tx, START + 29 * DAY)),
	).toEqual({ runs: 0, receipts: 0 });
	expect(count("kanban_runs")).toBe(runsBefore);

	const pruned = await store.write((tx) =>
		kanban.pruneInTransaction(tx, START + 31 * DAY),
	);
	// A's history is gone; B's current run and C's open run stay.
	expect(pruned.runs).toBe(1);
	expect(pruned.receipts).toBe(receiptsBefore);
	expect(count("kanban_receipts")).toBe(0);
	const left = view().runs.map((r) => r.id);
	expect(left).toContain(current);
	expect(left).toContain(open);
	expect(left).not.toContain(oldRun);
	expect(count("kanban_runs")).toBe(2);
});

test("prune() runs the retention with the service clock", async () => {
	const { kanban, add, count } = setup();
	await add("A");
	await kanban.prune();
	// The receipt is brand new: it stays.
	expect(count("kanban_receipts")).toBe(1);
});

/** Counts the statements the board reads. */
function countingTx(tx: Database) {
	const counter = { queries: 0 };
	const proxy = new Proxy(tx, {
		get(target, key) {
			if (key === "query")
				return (sql: string) => {
					counter.queries++;
					return target.query(sql);
				};
			const value = Reflect.get(target, key) as unknown;
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
	return { tx: proxy, counter };
}

test("followedByOtherRun is decided from the latest run of each card, and costs the same for any number of cards", async () => {
	const { store, view, add, run, finish } = setup();
	const ids: string[] = [];
	const queriesFor = () =>
		store.readSnapshot((tx) => {
			const { tx: counted, counter } = countingTx(tx);
			boardInTransaction(counted, { runnable: true });
			return counter.queries;
		});
	for (const title of ["A", "B", "C"]) {
		const id = await add(title);
		ids.push(id);
		await finish(await run(id));
	}
	const three = queriesFor();
	// Each earlier Done card was followed by a later card's run; the last one was not.
	expect(
		ids.map((id) => view().cards.find((c) => c.id === id)!.followedByOtherRun),
	).toEqual([true, true, false]);
	for (const title of ["D", "E", "F", "G"]) {
		const id = await add(title);
		await finish(await run(id));
	}
	expect(queriesFor()).toBe(three);
});
