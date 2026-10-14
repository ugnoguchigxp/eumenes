import { afterEach, expect, test } from "bun:test";
import type { KanbanBoardView } from "../domains/kanban";
import {
	addCard,
	boardData,
	cleanup,
	finishedEvent,
	invoke,
	revisionOf,
	setup,
} from "./kanban-adapter.fixture";

afterEach(cleanup);

type Harness = ReturnType<typeof setup>;

/** Waits until `read` returns something truthy (the stop and the retry run after the commit). */
async function until<T>(read: () => T | undefined | false): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const value = read();
		if (value) return value;
		await Bun.sleep(5);
	}
	throw new Error("until_timeout");
}

/** A card with a run handed over to the fake terminals. */
async function handedRun(h: Harness, title = "A") {
	const cardId = await addCard(h.store, h.adapter, title);
	const out = await h.store.write((tx) =>
		invoke(tx, h.adapter, "kanban.run", { cardId, expectedRevision: 1 }),
	);
	return { cardId, runId: (out.receipt as { runId: string }).runId };
}
const cardOf = (h: Harness, cardId: string) =>
	boardData(h.store, h.adapter).cards.find((c) => c.id === cardId)!;
const COMPLETED = { state: "completed", lastReport: "済", files: ["a.ts"] };

/** Terminals ends the request: the listener runs inside the transaction that wrote it. */
const endRequest = (h: Harness, runId: string, cardId: string) =>
	h.store.write((tx) => {
		for (const listener of h.fake.state.finished)
			listener(tx, finishedEvent(runId, cardId));
	});

test("a finish that fails once is settled from the request in a fresh transaction", async () => {
	const h = setup();
	const { cardId, runId } = await handedRun(h);
	const real = h.kanban.finishRunInTransaction;
	let calls = 0;
	h.kanban.finishRunInTransaction = (tx, finish) => {
		if (calls++ === 0) throw new Error("boom");
		return real(tx, finish);
	};
	h.fake.state.requests.set(runId, COMPLETED);
	await endRequest(h, runId, cardId);
	await until(() => cardOf(h, cardId).column === "finished");
	expect(cardOf(h, cardId)).toMatchObject({
		label: "done",
		lastReport: "済",
		files: ["a.ts"],
	});
	expect(boardData(h.store, h.adapter).queue.handedRunId).toBeUndefined();
});

test("the next run still goes after a failed finish; a request that ended unnoticed is settled by the periodic upkeep", async () => {
	const h = setup();
	const a = await handedRun(h, "A");
	const b = await handedRun(h, "B");
	expect(cardOf(h, b.cardId).column).toBe("running");
	const real = h.kanban.finishRunInTransaction;
	h.kanban.finishRunInTransaction = () => {
		throw new Error("boom");
	};
	h.fake.state.requests.set(a.runId, COMPLETED);
	await endRequest(h, a.runId, a.cardId);
	await until(() => cardOf(h, a.cardId).column === "finished");
	expect(h.fake.state.enqueued.map((r) => r.attemptId)).toEqual([
		a.runId,
		b.runId,
	]);

	// B's request ended without any listener noticing: the upkeep finds it.
	h.kanban.finishRunInTransaction = real;
	h.fake.state.requests.set(b.runId, { state: "ended", files: [] });
	expect(cardOf(h, b.cardId).column).toBe("running");
	await h.link.maintain();
	expect(cardOf(h, b.cardId)).toMatchObject({
		column: "finished",
		label: "blocker",
		reason: "ended",
	});
});

test("stop on a run whose request is already final settles the card (every stop answer but unconfirmed)", async () => {
	for (const answer of ["stopped", "final", "something-new"]) {
		const h = setup();
		const { cardId, runId } = await handedRun(h);
		h.fake.state.requests.set(runId, COMPLETED);
		h.fake.state.stopResult = answer as never;
		await h.store.write((tx) =>
			invoke(tx, h.adapter, "kanban.stop", {
				cardId,
				expectedRevision: revisionOf(h.store, h.adapter, cardId),
			}),
		);
		h.adapter.afterCommit!();
		await until(() => cardOf(h, cardId).column === "finished");
		expect(cardOf(h, cardId)).toMatchObject({ label: "done" });
		expect(boardData(h.store, h.adapter).queue.state).toBe("running");
		await cleanup();
	}
});

test("a stop that fails after the request ended still settles the card instead of pausing the queue", async () => {
	const h = setup();
	const { cardId, runId } = await handedRun(h);
	h.fake.state.requests.set(runId, { state: "ended", files: [] });
	h.fake.state.stopError = "terminal_not_running";
	await h.store.write((tx) =>
		invoke(tx, h.adapter, "kanban.stop", {
			cardId,
			expectedRevision: revisionOf(h.store, h.adapter, cardId),
		}),
	);
	h.adapter.afterCommit!();
	await until(() => cardOf(h, cardId).column === "finished");
	expect(cardOf(h, cardId)).toMatchObject({
		label: "blocker",
		reason: "ended",
	});
	expect(boardData(h.store, h.adapter).queue.state).toBe("running");
});

test("a stop that wrote no final state does not leave the run waiting forever: the queue stops", async () => {
	const h = setup();
	const { cardId, runId } = await handedRun(h);
	h.fake.state.requests.set(runId, { state: "started", files: [] });
	h.fake.state.stopResult = "stopped";
	await h.store.write((tx) =>
		invoke(tx, h.adapter, "kanban.stop", {
			cardId,
			expectedRevision: revisionOf(h.store, h.adapter, cardId),
		}),
	);
	h.adapter.afterCommit!();
	await until(
		() => boardData(h.store, h.adapter).queue.state === "paused" || undefined,
	);
	expect(boardData(h.store, h.adapter).queue).toMatchObject({
		reason: "stop_unconfirmed",
		handedRunId: runId,
	});
});

test("recovery that cannot hand the next run over blocks it and stops the queue instead of failing the startup", async () => {
	const h = setup();
	const a = await handedRun(h, "A");
	const b = await handedRun(h, "B");
	expect(cardOf(h, b.cardId).column).toBe("running");
	h.fake.state.requests.set(a.runId, COMPLETED);
	h.fake.state.failEnqueue = "terminal_tracking_unavailable";
	await h.link.recover();
	expect(cardOf(h, a.cardId)).toMatchObject({ label: "done" });
	expect(cardOf(h, b.cardId)).toMatchObject({
		column: "finished",
		label: "blocker",
		reason: "send_failed",
	});
	const board: KanbanBoardView = boardData(h.store, h.adapter);
	expect(board.queue).toMatchObject({
		state: "paused",
		reason: "tracking_lost",
	});
});
