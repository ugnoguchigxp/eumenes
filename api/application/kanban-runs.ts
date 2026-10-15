import type { Database } from "bun:sqlite";
import type {
	KanbanBoardView,
	KanbanDispatch,
	KanbanRecoverPorts,
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

const PRUNE_EVERY_MS = 60 * 60 * 1000;
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

/**
 * Hands the next run to terminals inside the caller's transaction. When terminals cannot take it
 * (tracking became unavailable) only that hand-over is undone: the run becomes a Blocker and the
 * queue stops, instead of the failure aborting the caller (a final state, or the startup).
 */
function handOver(
	kanban: KanbanService,
	terminals: Pick<TerminalsService, "enqueueInTransaction">,
	tx: Database,
	dispatch: KanbanDispatch,
) {
	const handed = guarded(tx, "kanban_dispatch", () =>
		enqueueDispatch(terminals, tx, dispatch),
	);
	if (!handed) kanban.dispatchFailedInTransaction(tx, dispatch.runId);
}

type RecoveryTerminals = Pick<
	TerminalsService,
	"requestInTransaction" | "enqueueInTransaction"
>;
/** What settling a run from its terminals request reads and hands over. */
const portsOf = (
	kanban: KanbanService,
	terminals: RecoveryTerminals,
): KanbanRecoverPorts => ({
	handles: (id) => id === "claude-code",
	request: (tx, runId) => terminals.requestInTransaction(tx, runId),
	enqueue: (tx, dispatch) => handOver(kanban, terminals, tx, dispatch),
});

/**
 * Settles handed runs whose request is already final (see `KanbanService.reconcile`). Never
 * throws: a failure is logged and the next call tries again.
 */
function createReconciler(kanban: KanbanService, terminals: RecoveryTerminals) {
	return async (check?: { always?: boolean }): Promise<void> => {
		try {
			// A run settled here was stuck: worth a trace.
			if ((await kanban.reconcile(portsOf(kanban, terminals), check)) > 0)
				log.warn("kanban.runs_reconciled", {});
		} catch (error) {
			log.warn("kanban.reconcile_failed", {}, error);
		}
	};
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
	const reconcile = createReconciler(kanban, terminals);
	const offFinished = terminals.onFinishedInTransaction((tx, event) => {
		if (!isKanbanOwner(event.owner)) return;
		const settled = guarded(tx, "kanban_finish", () => {
			const dispatch = kanban.finishRunInTransaction(
				tx,
				finishOf(event),
			)?.dispatch;
			if (dispatch) handOver(kanban, terminals, tx, dispatch);
		});
		// The request is final but the card could not follow: settle it from the request once
		// this transaction committed (the writer runs after it), so the queue does not stay blocked.
		if (!settled) void reconcile({ always: true });
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
	let prunedAt = 0;
	return {
		/** Startup: settle handed-over runs from their requests (after terminals' recovery). */
		recover: () => kanban.recover(portsOf(kanban, terminals)),
		/** Settles handed runs whose request is final but whose card did not follow. */
		reconcile: () => reconcile(),
		/**
		 * Periodic upkeep for the host (every few tens of seconds): reconciles stuck runs, and
		 * about once an hour deletes old final runs and receipts. Never throws.
		 */
		async maintain() {
			await reconcile();
			if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
			prunedAt = Date.now();
			try {
				await kanban.prune();
			} catch (error) {
				log.warn("kanban.prune_failed", {}, error);
			}
		},
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
	terminals: Pick<TerminalsService, "stop"> & RecoveryTerminals,
) {
	const inflight = new Set<string>();
	const reconcile = createReconciler(kanban, terminals);
	const stillPending = (runId: string) => kanban.pendingStops().includes(runId);
	return {
		flush() {
			for (const runId of kanban.pendingStops()) {
				if (inflight.has(runId)) continue;
				inflight.add(runId);
				void terminals
					.stop(runId)
					// Whatever terminals answers except "unconfirmed" (stopped, already final, or a
					// value added later), its request may be final: the card follows it.
					.then(async (result) => {
						if (result !== "unconfirmed") await reconcile();
						// Still handed with the stop pending: no final state was written.
						if (result === "unconfirmed" || stillPending(runId))
							await kanban.stopUnconfirmed(runId);
					})
					.catch(async (error) => {
						log.warn("kanban.stop_failed", { runId }, error);
						// A request that already ended settles the run; otherwise the stop is unconfirmed.
						await reconcile();
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
	// A Kanban session that is busy although no handed run is on it holds the queue back.
	const manual = sessions.find(
		(s) =>
			isKanbanOwner(s.owner) &&
			(s.activity === "working" || s.activity === "waiting") &&
			!board.runs.some(
				(run) =>
					run.state === "handed" &&
					s.owner === ownerOf(run.cardId) &&
					s.claudeSessionId === run.claudeSessionId,
			),
	);
	return {
		...board,
		queue: {
			...board.queue,
			...(manual
				? {
						manual: {
							activity: manual.activity as "working" | "waiting",
							stale: manual.stale === true,
						},
					}
				: {}),
		},
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
