import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	createKanban,
	migrations as kanbanMigrations,
	type KanbanBoardView,
} from "../domains/kanban";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { createKanbanAdapter } from "./kanban-adapter";
import { connectKanbanRuns } from "./kanban-runs";
import { migrations } from "./migrations";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
/** Closes the stores and removes the directories `setup` made; register it with `afterEach`. */
export async function cleanup() {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

type Enqueued = import("../domains/terminals").EnqueueRequest;
/** A terminals stand-in that records what is handed over and answers the board's questions. */
function fakeTerminals() {
	const state = {
		enqueued: [] as Enqueued[],
		unsent: false,
		failEnqueue: undefined as string | undefined,
		stops: [] as string[],
		/** Makes `stop` fail with this message. */
		stopError: undefined as string | undefined,
		stopResult: "stopped" as "stopped" | "unconfirmed" | "final",
		/** The terminals request of each run, as `requestInTransaction` answers. */
		requests: new Map<
			string,
			{
				state: string;
				reason?: string;
				lastReport?: string;
				files?: readonly string[];
			}
		>(),
		sessions: [] as ReturnType<TerminalsPort["activities"]>,
		finished: [] as Array<(tx: Database, event: Finished) => void>,
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
			if (state.stopError) throw new Error(state.stopError);
			return state.stopResult as "stopped" | "unconfirmed";
		},
		activities: () => state.sessions,
		onFinishedInTransaction: (
			listener: (tx: Database, event: Finished) => void,
		) => {
			state.finished.push(listener);
			return () => {};
		},
		onWaitingInTransaction: () => () => {},
	} satisfies TerminalsPort;
	return { terminals, state };
}
type TerminalsPort = import("./kanban-runs").KanbanTerminals;
type Finished = import("../domains/terminals").TerminalRequestFinished;

export function setup(runnable = true) {
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
	const link = connectKanbanRuns(kanban, fake.terminals);
	const adapter = createKanbanAdapter(kanban, {
		runnable: () => state.runnable,
	});
	return { store, adapter, state, kanban, fake, link };
}

export const origin = { kind: "ui" as const, scope: "s", actionRequestId: "a" };
let n = 0;
export const invoke = (
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
export const board = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
) =>
	store.read((tx) =>
		adapter.sourceInTransaction(tx, "query:kanban.board@1", undefined)!,
	);

export const addCard = async (
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
export const boardData = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
) => board(store, adapter).data as KanbanBoardView;
export const revisionOf = (
	store: SqliteStore,
	adapter: ReturnType<typeof setup>["adapter"],
	cardId: string,
) => boardData(store, adapter).cards.find((c) => c.id === cardId)!.revision;

/** What terminals tells the board when a request ends (inside the transaction that ends it). */
export const finishedEvent = (
	runId: string,
	cardId: string,
	over: Partial<import("../domains/terminals").TerminalRequestFinished> = {},
): import("../domains/terminals").TerminalRequestFinished => ({
	attemptId: runId,
	state: "completed",
	owner: `kanban:${cardId}` as never,
	origin: "board",
	task: "T",
	lastReport: "済",
	files: ["a.ts"],
	...over,
});
