import type { Database } from "bun:sqlite";
import type {
	KanbanBoardView,
	KanbanDispatch,
	KanbanService,
} from "../domains/kanban";
import type {
	TerminalRequestFinished,
	TerminalsService,
} from "../domains/terminals";
import { getLogger } from "../infrastructure/logger";

const log = getLogger("kanban");

/** The part of terminals the board's runs use. */
export type KanbanTerminals = Pick<
	TerminalsService,
	| "enqueueInTransaction"
	| "cancelQueuedInTransaction"
	| "requestInTransaction"
	| "stop"
	| "activities"
	| "onFinishedInTransaction"
	| "onWaitingInTransaction"
>;

const OWNER_PREFIX = "kanban:";
const ownerOf = (cardId: string) => `${OWNER_PREFIX}${cardId}` as const;
const isKanbanOwner = (owner: string) => owner.startsWith(OWNER_PREFIX);

/**
 * Hands one run to terminals inside the caller's writer transaction (nothing is sent before
 * commit). All Kanban requests share the exclusive group, so they never start while a Kanban
 * session is working or waiting.
 */
export function enqueueDispatch(
	terminals: Pick<TerminalsService, "enqueueInTransaction">,
	tx: Database,
	dispatch: KanbanDispatch,
) {
	terminals.enqueueInTransaction(tx, {
		attemptId: dispatch.runId,
		owner: ownerOf(dispatch.cardId),
		target: dispatch.target,
		claudeSessionId: dispatch.claudeSessionId,
		mode: dispatch.mode,
		projectId: dispatch.projectId,
		prompt: dispatch.prompt,
		task: dispatch.task,
		origin: dispatch.origin,
		...(dispatch.conversationId
			? { conversationId: dispatch.conversationId }
			: {}),
		exclusiveGroup: "kanban",
	});
}

/** Runs `work` so that a failure undoes only its own writes. */
function guarded(tx: Database, name: string, work: () => void): boolean {
	tx.exec(`SAVEPOINT ${name}`);
	try {
		work();
		tx.exec(`RELEASE ${name}`);
		return true;
	} catch (error) {
		tx.exec(`ROLLBACK TO ${name}`);
		tx.exec(`RELEASE ${name}`);
		log.warn("kanban.run_hook_failed", { phase: name }, error);
		return false;
	}
}

const finishOf = (event: TerminalRequestFinished) => ({
	runId: event.attemptId,
	state: event.state,
	reason: event.reason,
	lastReport: event.lastReport,
	files: event.files,
});

type Connection = {
	terminals: KanbanTerminals;
	stopper: ReturnType<typeof createStopper>;
};
/**
 * The terminals each board service is connected to. The adapter is built with the toolchain,
 * before the host connects the runs; it reads the connection when an operation needs terminals.
 */
const connections = new WeakMap<KanbanService, Connection>();

/** The connection of a board service, or undefined while the host has not connected it. */
export const connectionOf = (kanban: KanbanService): Connection | undefined =>
	connections.get(kanban);

/**
 * Connects the board to terminals: a run's final state is written to the card in the same
 * transaction that ends the request, and the next run is handed over there too. A failure of
 * the board's part never undoes terminals' final state (the card stays running and can be
 * stopped by the person). Returns the startup recovery and the disconnect.
 */
export function connectKanbanRuns(
	kanban: KanbanService,
	terminals: KanbanTerminals,
) {
	const offFinished = terminals.onFinishedInTransaction((tx, event) => {
		if (!isKanbanOwner(event.owner)) return;
		guarded(tx, "kanban_finish", () => {
			const out = kanban.finishRunInTransaction(tx, finishOf(event));
			const dispatch = out?.dispatch;
			if (!dispatch) return;
			const handed = guarded(tx, "kanban_dispatch", () =>
				enqueueDispatch(terminals, tx, dispatch),
			);
			// Terminals cannot take the next run (tracking became unavailable): stop the queue.
			if (!handed) kanban.dispatchFailedInTransaction(tx, dispatch.runId);
		});
	});
	const offWaiting = terminals.onWaitingInTransaction((tx, event) => {
		if (!isKanbanOwner(event.owner)) return;
		guarded(tx, "kanban_waiting", () =>
			kanban.waitingInTransaction(tx, event.attemptId),
		);
	});
	connections.set(kanban, {
		terminals,
		stopper: createStopper(kanban, terminals),
	});
	return {
		/** Startup: settle handed-over runs from their requests (after terminals' recovery). */
		recover: () =>
			kanban.recover({
				request: (tx, runId) => terminals.requestInTransaction(tx, runId),
				enqueue: (tx, dispatch) => enqueueDispatch(terminals, tx, dispatch),
			}),
		disconnect() {
			offFinished();
			offWaiting();
			connections.delete(kanban);
		},
	};
}

/**
 * Carries out the stops the person asked for, after the transaction that recorded them
 * committed. The process end is confirmed by terminals (which then writes the final state, and
 * the card becomes a Blocker); when it cannot be confirmed the queue stops.
 */
export function createStopper(
	kanban: KanbanService,
	terminals: Pick<TerminalsService, "stop">,
) {
	const inflight = new Set<string>();
	return {
		flush() {
			for (const runId of kanban.pendingStops()) {
				if (inflight.has(runId)) continue;
				inflight.add(runId);
				void terminals
					.stop(runId)
					.then((result) =>
						result === "unconfirmed" ? kanban.stopUnconfirmed(runId) : undefined,
					)
					.catch(async (error) => {
						log.warn("kanban.stop_failed", { runId }, error);
						await kanban.stopUnconfirmed(runId);
					})
					.catch((error) =>
						log.warn("kanban.stop_unconfirmed_save_failed", { runId }, error),
					)
					.finally(() => inflight.delete(runId));
			}
		},
	};
}

/**
 * The board as the screen reads it: each handed-over run with its terminals request state and
 * the activity of its session, and a stop turned into a cancel while the request is unsent.
 */
export function composeBoard(
	board: KanbanBoardView,
	tx: Database,
	terminals: Pick<TerminalsService, "requestInTransaction" | "activities">,
): KanbanBoardView {
	const sessions = terminals
		.activities()
		.filter((session) => session.status === "running");
	const runs = board.runs.map((run) => {
		if (run.state !== "handed") return run;
		const request = terminals.requestInTransaction(tx, run.id);
		const session = sessions.find(
			(s) =>
				s.owner === ownerOf(run.cardId) &&
				s.claudeSessionId === run.claudeSessionId,
		);
		return {
			...run,
			...(request ? { requestState: request.state } : {}),
			...(session && request && request.state !== "queued"
				? { activity: session.activity }
				: {}),
		};
	});
	const unsent = new Set(
		runs.filter((run) => run.requestState === "queued").map((run) => run.id),
	);
	return {
		...board,
		runs,
		cards: board.cards.map((card) =>
			card.currentRunId && unsent.has(card.currentRunId)
				? {
						...card,
						actions: card.actions.map((a) => (a === "stop" ? "cancel" : a)),
					}
				: card,
		),
	};
}
