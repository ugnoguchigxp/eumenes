import type { Database } from "bun:sqlite";
import {
	specialistCommandKinds,
	type SpecialistCommand,
	type SpecialistCommandKind,
	type SpecialistRetarget,
	type SpecialistSession,
} from "../contracts";
import {
	byId,
	insertReceipt,
	liveSession,
	patchSession,
	receiptById,
	sessionById,
	sweepCandidates,
	suspendedSessions,
	unfinishedSessionRuns,
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
import { forwardToMain } from "./specialist-settle";
import { openSessionInTransaction } from "./specialist-start";

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
			const before = deps.specialist!.workStateInTransaction(
				tx,
				record.adapterRef,
				record.workRef,
			);
			// Utterances queued behind the turn in flight go to the main agent in their order (D5); they leave
			// the session first, so withdrawing the turn hands the work to none of them.
			for (const queued of unfinishedSessionRuns(tx, record.id)) {
				const sibling =
					queued.id === record.activeRunId ? null : byId(tx, queued.id);
				if (sibling?.status === "queued")
					forwardToMain(
						deps,
						tx,
						sibling,
						record,
						before?.dirty ? "suspended" : "ended",
						before?.label ?? record.label,
					);
			}
			// The turn in flight is withdrawn; the work is then free.
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

	/**
	 * The active session goes on with another saved item of its toolchain: a clean work (or a dirty one the
	 * user chose to discard) ends and a new session opens on the item. The same item keeps the session.
	 */
	function retarget(
		tx: Database,
		sessionId: string,
		input: SpecialistRetarget,
		cancelled: Cancelled,
	): { session: SpecialistSession } {
		// The receipt's kind names the choice, so the same request id with another choice is a conflict.
		const kind = `retarget:${input.targetRef}:${input.discardUnsaved}`;
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
		const port = deps.specialist!;
		const record = sessionById(tx, sessionId);
		if (!record) throw new Error("specialist_session_not_found");
		if (record.state === "ended") throw new Error("session_ended");
		if (record.revision !== input.expectedRevision)
			throw new Error("revision_conflict");
		if (record.state !== "active") throw new Error("session_not_active");
		if (sessionExpired(record, clock())) throw new Error("session_expired");
		const set = port.setInTransaction(tx, record.toolchainRevisionId);
		if (
			!port
				.targetChoicesInTransaction(tx, set, input.targetRef)
				.some((choice) => choice.ref === input.targetRef)
		)
			throw new Error("target_not_found");
		const work = port.workStateInTransaction(
			tx,
			record.adapterRef,
			record.workRef,
		);
		let next = record;
		if ((work?.savedRef ?? null) !== input.targetRef) {
			// A turn holding the work, or an utterance accepted for it, is never dropped by a switch.
			if (work?.busy || record.activeRunId) throw new Error("work_busy");
			if (work?.dirty && !input.discardUnsaved) throw new Error("work_unsaved");
			// A refusal of the work's end rolls the whole command back: the session stays as it was.
			absorb(
				cancelled,
				endSessionInTransaction(
					deps,
					tx,
					record,
					work?.dirty ? "discarded" : "closed",
				),
			);
			next = openSessionInTransaction(
				deps,
				tx,
				set,
				record.conversationId,
				input.targetRef,
			);
		}
		const result = { session: sessionView(deps, tx, fresh(tx, next.id)) };
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
		async retarget(
			sessionId: string,
			input: SpecialistRetarget,
		): Promise<{ session: SpecialistSession }> {
			if (!deps.specialist) throw new Error("specialist_unavailable");
			const cancelled = none();
			const result = await store.write((tx) =>
				retarget(tx, sessionId, input, cancelled),
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
