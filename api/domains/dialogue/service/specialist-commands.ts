import type { Database } from "bun:sqlite";
import {
	specialistCommandKinds,
	type SpecialistCommand,
	type SpecialistCommandKind,
	type SpecialistSession,
} from "../contracts";
import {
	insertReceipt,
	liveSession,
	patchSession,
	receiptById,
	sessionById,
	sweepCandidates,
	suspendedSessions,
	unfinishedSessions,
	type SessionRecord,
} from "../repository";
import type { DialogueDeps } from "./context";
import {
	cancelSessionRuns,
	endOrMarkClosing,
	endSessionInTransaction,
	expiryAfter,
	flushCancelled,
	sessionExpired,
	sessionView,
} from "./specialist-core";

/** Jobs and runs cancelled inside a transaction: aborted once it commits. */
type Cancelled = { jobs: string[]; runs: string[] };
const none = (): Cancelled => ({ jobs: [], runs: [] });
const absorb = (into: Cancelled, from: { flush: string[]; runs: string[] }) => {
	into.jobs.push(...from.flush);
	into.runs.push(...from.runs);
};

/**
 * The session operations the screen and the application use: reading the conversation's session, the
 * commands (idempotent by requestId, guarded by the revision the screen saw), the periodic sweep and the
 * restart recovery. Every write runs in the caller's single writer transaction.
 */
export function createSpecialistOps(deps: DialogueDeps) {
	const { store, clock } = deps;

	function fresh(tx: Database, id: string): SessionRecord {
		return sessionById(tx, id) as SessionRecord;
	}

	function run(
		tx: Database,
		record: SessionRecord,
		kind: SpecialistCommandKind,
		cancelled: Cancelled,
	) {
		const now = clock();
		const expired = sessionExpired(record, now);
		if (record.state === "closing" && (kind === "return" || kind === "resume"))
			throw new Error("session_closing");
		if (kind === "resume") {
			if (record.state !== "suspended")
				throw new Error("session_not_suspended");
			if (expired) throw new Error("session_expired");
			patchSession(
				tx,
				record.id,
				{
					state: "active",
					epoch: record.epoch + 1,
					expiresAt: expiryAfter(now),
					pendingSwitch: null,
					bump: true,
				},
				now,
			);
			return;
		}
		if (kind === "return") {
			if (expired) {
				absorb(cancelled, endOrMarkClosing(deps, tx, record, "expired"));
				return;
			}
			if (record.state === "suspended") return;
			// The turn in flight and any queued behind it are withdrawn first; the work is then free.
			absorb(cancelled, cancelSessionRuns(deps, tx, record.id));
			const current = fresh(tx, record.id);
			const work = deps.specialist!.workStateInTransaction(
				tx,
				current.adapterRef,
				current.workRef,
			);
			if (work?.dirty)
				patchSession(
					tx,
					current.id,
					{
						state: "suspended",
						label: work.label,
						pendingSwitch: null,
						bump: true,
					},
					now,
				);
			else absorb(cancelled, endOrMarkClosing(deps, tx, current, "returned"));
			return;
		}
		if (kind === "close") {
			const work = deps.specialist!.workStateInTransaction(
				tx,
				record.adapterRef,
				record.workRef,
			);
			if (work?.dirty) throw new Error("work_unsaved");
			if (work?.busy) throw new Error("work_busy");
			absorb(cancelled, endSessionInTransaction(deps, tx, record, "closed"));
			return;
		}
		// discard: the draft goes (a refusal such as work_busy rolls the whole command back)
		absorb(cancelled, endSessionInTransaction(deps, tx, record, "discarded"));
	}

	function apply(
		tx: Database,
		sessionId: string,
		kind: SpecialistCommandKind,
		input: SpecialistCommand,
		cancelled: Cancelled,
	): { session: SpecialistSession } {
		const receipt = receiptById(tx, input.requestId);
		if (receipt) {
			if (
				receipt.sessionId !== sessionId ||
				receipt.kind !== kind ||
				receipt.expectedRevision !== input.expectedRevision
			)
				throw new Error("request_conflict");
			return JSON.parse(receipt.resultJson);
		}
		const record = sessionById(tx, sessionId);
		if (!record) throw new Error("specialist_session_not_found");
		if (record.state === "ended") throw new Error("session_ended");
		if (record.revision !== input.expectedRevision)
			throw new Error("revision_conflict");
		run(tx, record, kind, cancelled);
		const result = { session: sessionView(deps, tx, fresh(tx, sessionId)) };
		insertReceipt(
			tx,
			{
				requestId: input.requestId,
				sessionId,
				kind,
				expectedRevision: input.expectedRevision,
				resultJson: JSON.stringify(result),
			},
			clock(),
		);
		return result;
	}

	/** Sessions past their expiry, closing ones (retried) and suspended ones whose work was saved meanwhile. */
	function sweepInTransaction(db: Database, now: string): Cancelled {
		const cancelled = none();
		if (!deps.specialist) return cancelled;
		for (const record of sweepCandidates(db, now))
			absorb(
				cancelled,
				endOrMarkClosing(
					deps,
					db,
					record,
					record.state === "closing"
						? (record.closingReason ?? "expired")
						: "expired",
				),
			);
		for (const record of suspendedSessions(db)) {
			const work = deps.specialist.workStateInTransaction(
				db,
				record.adapterRef,
				record.workRef,
			);
			// A suspended work with nothing unsaved (saved in its screen) has nothing left to keep.
			if (!work || !work.dirty)
				absorb(cancelled, endOrMarkClosing(deps, db, record, "closed"));
		}
		return cancelled;
	}

	/** After a restart every session that was not ended ends: unsaved work does not survive it. */
	function recoverInTransaction(db: Database): Cancelled {
		const cancelled = none();
		if (!deps.specialist) return cancelled;
		for (const record of unfinishedSessions(db))
			absorb(cancelled, endOrMarkClosing(deps, db, record, "restarted"));
		return cancelled;
	}

	return {
		/**
		 * Whether the session may still change its work: active or suspended, not expired, not closing. The
		 * guard the work's own screen operations (undo, redo, save) check in their transaction.
		 */
		liveInTransaction(db: Database, sessionId: string): boolean {
			const record = sessionById(db, sessionId);
			return (
				!!record &&
				(record.state === "active" || record.state === "suspended") &&
				!sessionExpired(record, clock())
			);
		},
		/** The conversation's live (not ended) session, or null. */
		session(conversationId: string): SpecialistSession | null {
			if (!deps.specialist) return null;
			return store.read((db) => {
				const record = liveSession(db, conversationId);
				return record ? sessionView(deps, db, record) : null;
			});
		},
		async command(
			sessionId: string,
			kind: SpecialistCommandKind,
			input: SpecialistCommand,
		): Promise<{ session: SpecialistSession }> {
			if (!deps.specialist || !specialistCommandKinds.includes(kind))
				throw new Error("specialist_unavailable");
			const cancelled = none();
			const result = await store.write((tx) =>
				apply(tx, sessionId, kind, input, cancelled),
			);
			flushCancelled(deps, cancelled.jobs, cancelled.runs);
			return result;
		},
		sweepInTransaction,
		recoverInTransaction,
		async sweep(): Promise<void> {
			const cancelled = await store.write((db) =>
				sweepInTransaction(db, clock()),
			);
			flushCancelled(deps, cancelled.jobs, cancelled.runs);
		},
		async recover(): Promise<void> {
			const cancelled = await store.write((db) => recoverInTransaction(db));
			flushCancelled(deps, cancelled.jobs, cancelled.runs);
		},
	};
}
