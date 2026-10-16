import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type {
	EnqueueRequest,
	RequestState,
	SessionOwner,
	TerminalRequestFinished,
	TerminalRequestView,
} from "../contracts";
import { LAST_MESSAGE_CHARS } from "./hooks";
import * as repository from "../repository";
import {
	enqueueRequestSchema,
	requestDigest,
	toFinished,
	toView,
} from "./requests";
import type { Inflight, Outcome, Runtime, Session } from "./types";

const log = getLogger("terminals");

/** States a request can still leave. */
const OPEN_STATES: readonly RequestState[] = [
	"queued",
	"sending",
	"delivered",
	"started",
];

/** How long and how many final requests are kept. */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const RETAIN_FINAL_ROWS = 2000;

type FinishedListener = (tx: Database, event: TerminalRequestFinished) => void;
type WaitingListener = (
	tx: Database,
	event: { attemptId: string; owner: SessionOwner },
) => void;

/**
 * Every change of a saved request. Final states are written in one writer transaction together
 * with the in-transaction listeners, so a listener's own writes commit or roll back with them.
 */
export function createLedger(rt: Runtime) {
	const finished = new Set<FinishedListener>();
	const waiting = new Set<WaitingListener>();
	const committed = new Set<(event: TerminalRequestFinished) => void>();
	/** Final states written in a transaction that has not been seen to commit yet. */
	let uncommitted: TerminalRequestFinished[] = [];
	/** Final states whose save failed: tried once more by the next hook or sweep. */
	const unsaved = new Map<string, { outcome: Outcome; session?: Session }>();
	const store = () => {
		const value = rt.options.store;
		if (!value) throw new Error("terminal_tracking_unavailable");
		return value;
	};

	function finalizeIn(
		tx: Database,
		id: string,
		outcome: Outcome,
		files?: readonly string[],
	): TerminalRequestFinished | null {
		const moved = repository.transition(
			tx,
			id,
			OPEN_STATES,
			{
				state: outcome.state,
				reason: outcome.reason,
				lastReport: outcome.report?.slice(0, LAST_MESSAGE_CHARS) || undefined,
				files,
			},
			rt.nowIso(),
		);
		if (!moved) return null;
		const event = toFinished(repository.get(tx, id)!);
		for (const listener of finished) listener(tx, event);
		if (committed.size > 0) uncommitted.push(event);
		return event;
	}

	async function attempt(id: string, outcome: Outcome, session?: Session) {
		const flight = session?.inflight?.id === id ? session.inflight : undefined;
		const event = await store().write((tx) =>
			finalizeIn(tx, id, outcome, flight?.files),
		);
		if (flight && session?.inflight === flight) {
			delete session.inflight;
			session.lastUsedAtMs = rt.now();
		}
		rt.changed();
		rt.kick();
		return event !== null;
	}

	return {
		enqueue(tx: Database, input: EnqueueRequest): TerminalRequestView {
			const parsed = enqueueRequestSchema.safeParse(input);
			if (!parsed.success) {
				if (
					parsed.error.issues.some(
						(i) => i.message === "terminal_prompt_invalid",
					)
				)
					throw new Error("terminal_prompt_invalid");
				throw parsed.error;
			}
			// Kanban's single-run rule applies to every request of a card, whatever the caller sent.
			const request = {
				...parsed.data,
				...(parsed.data.owner.startsWith("kanban:")
					? { exclusiveGroup: "kanban" as const }
					: {}),
			} as EnqueueRequest;
			const digest = requestDigest(request);
			const saved = repository.get(tx, request.attemptId);
			if (saved) {
				if (saved.digest !== digest)
					throw new Error("terminal_request_conflict");
				return toView(saved);
			}
			if (!rt.trackable()) throw new Error("terminal_tracking_unavailable");
			if (!rt.projects(request.projectId))
				throw new Error("terminal_project_unknown");
			const at = rt.nowIso();
			repository.insert(tx, {
				id: request.attemptId,
				digest,
				owner: request.owner,
				target: request.target,
				mode: request.mode,
				projectId: request.projectId,
				task: request.task,
				prompt: request.prompt,
				origin: request.origin,
				conversationId: request.conversationId,
				claudeSessionId:
					request.claudeSessionId ??
					(request.target === "new" ? crypto.randomUUID() : undefined),
				exclusiveGroup: request.exclusiveGroup,
				createdAt: at,
			});
			return toView(repository.get(tx, request.attemptId)!);
		},

		/** queued -> sending, only while still queued; false when it was cancelled first. */
		markSending: (id: string, sessionId: string, run: number) =>
			store().write((tx) => {
				const row = repository.get(tx, id);
				if (!row) return false;
				if (
					rt.options.workspace &&
					!rt.options.workspace.reserveSending(tx, {
						sessionId,
						owner: row.owner,
						cwd: rt.projects(row.projectId)?.cwd,
						run,
					})
				)
					return false;
				return repository.transition(
					tx,
					id,
					["queued"],
					{ state: "sending", terminalSessionId: sessionId, terminalRun: run },
					rt.nowIso(),
				);
			}),

		/** sending -> delivered; a request that already started stays as it is. */
		markDelivered: (id: string) =>
			store().write((tx) =>
				repository.transition(
					tx,
					id,
					["sending"],
					{ state: "delivered" },
					rt.nowIso(),
				),
			),

		markStarted: (id: string, promptId: string) =>
			store().write((tx) =>
				repository.transition(
					tx,
					id,
					["sending", "delivered"],
					{ state: "started", promptId },
					rt.nowIso(),
				),
			),

		/**
		 * Writes the final state and calls the finished listeners in one transaction. Returns
		 * whether this call made the request final (false: it already was). A failed save is
		 * kept for one more try and thrown.
		 */
		async finalize(id: string, outcome: Outcome, session?: Session) {
			try {
				const done = await attempt(id, outcome, session);
				unsaved.delete(id);
				return done;
			} catch (error) {
				unsaved.set(id, { outcome, session });
				throw error;
			}
		},

		/** The one more try of final states that could not be saved. */
		async retryUnsaved() {
			for (const [id, entry] of unsaved) {
				unsaved.delete(id);
				try {
					await attempt(id, entry.outcome, entry.session);
				} catch {
					log.warn("terminals.finish_save_failed", { attemptId: id });
				}
			}
		},

		/** A request waits for the person's permission: the listeners hear it once. */
		async notifyWaiting(flight: Inflight) {
			if (waiting.size === 0) return;
			await store().write((tx) => {
				for (const listener of waiting)
					listener(tx, { attemptId: flight.id, owner: flight.owner });
			});
		},

		/** Startup: nothing sent before the restart is known to have arrived or finished. */
		async recover() {
			if (!rt.options.store) return;
			await rt.options.store.write((tx) => {
				for (const row of repository.open(tx)) {
					finalizeIn(
						tx,
						row.id,
						row.state === "queued"
							? { state: "cancelled", reason: "restarted" }
							: { state: "unknown", reason: "restarted" },
					);
				}
			});
			rt.changed();
		},

		cancelQueued(tx: Database, id: string): boolean {
			return repository.transition(
				tx,
				id,
				["queued"],
				{ state: "cancelled", reason: "cancelled_by_person" },
				rt.nowIso(),
			);
		},

		request: (tx: Database, id: string) => repository.get(tx, id),

		/**
		 * Retention: final requests older than 30 days are deleted, and at most the newest 2000
		 * final ones are kept. Open requests stay. Returns the number of deleted rows.
		 */
		prune(tx: Database, now: Date): number {
			const cutoff = new Date(now.getTime() - RETAIN_MS).toISOString();
			return repository.pruneFinal(tx, cutoff, RETAIN_FINAL_ROWS);
		},

		/**
		 * Tells the after-commit listeners about final states, once the transaction that wrote them
		 * committed (call from the store's commit notification). A state that was rolled back
		 * is not reported: the request is read again and must still be in that state.
		 */
		flushCommitted() {
			const store = rt.options.store;
			if (!store || uncommitted.length === 0) return;
			const events = uncommitted;
			uncommitted = [];
			for (const event of events) {
				const row = store.read((db) => repository.get(db, event.attemptId));
				if (row?.state !== event.state) continue;
				for (const listener of committed) listener(event);
			}
		},

		onFinished(listener: FinishedListener) {
			finished.add(listener);
			return () => {
				finished.delete(listener);
			};
		},
		onFinishedCommitted(listener: (event: TerminalRequestFinished) => void) {
			committed.add(listener);
			return () => {
				committed.delete(listener);
			};
		},
		onWaiting(listener: WaitingListener) {
			waiting.add(listener);
			return () => {
				waiting.delete(listener);
			};
		},
	};
}
export type Ledger = ReturnType<typeof createLedger>;
