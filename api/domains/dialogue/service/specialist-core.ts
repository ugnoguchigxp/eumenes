import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type {
	Run,
	SpecialistEndReason,
	SpecialistSession,
	SpecialistSet,
} from "../contracts";
import {
	byId,
	extendRunDeadline,
	patchSession,
	unfinishedSessionRuns,
	type SessionRecord,
} from "../repository";
import type { DialogueDeps } from "./context";
import { endRun } from "./run-end";

const log = getLogger("dialogue");

/** The only expiry of a session: no user utterance, resume or accepted edit for this long ends it. */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** One specialist turn (model calls and their operations) of a toolchain without its own turn time. */
export const TURN_BUDGET_MS = 120_000;

/**
 * A toolchain with its own run time (spec toolchain-time-limits-design 2026-10-18 §3.2): from the hand-over the
 * run, and the model requests it stands on, may last `runMs`. Only ever later. Returns the run as it is now.
 */
export function extendRunForToolchain(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	set: SpecialistSet,
): Run {
	const runMs = set.timeLimits?.runMs;
	if (!runMs) return run;
	const until = Date.parse(deps.clock()) + runMs;
	if (run.deadlineAt && until <= Date.parse(run.deadlineAt)) return run;
	const deadlineAt = new Date(until).toISOString();
	extendRunDeadline(tx, run.id, deadlineAt);
	deps.larm.extendDeadlineInTransaction?.(tx, run.id, until);
	log.info("dialogue.deadline_extended", {
		runId: run.id,
		toolchainId: set.toolchainId,
		limitMs: runMs,
	});
	return { ...run, deadlineAt };
}

export const expiryAfter = (now: string) =>
	new Date(Date.parse(now) + SESSION_IDLE_MS).toISOString();
export const sessionExpired = (session: SessionRecord, now: string) =>
	Date.parse(session.expiresAt) <= Date.parse(now);

/** Safe classification of an error thrown by a port: its `/^[a-z_]+$/` code, else a generic one. */
export function safeCode(error: unknown, fallback: string): string {
	return error instanceof Error && /^[a-z_]+$/.test(error.message)
		? error.message
		: fallback;
}

/** The provider's session of a specialist ends with the session; losing it early only costs a re-sent context. */
function releaseProviderSession(deps: DialogueDeps, sessionId: string) {
	deps.larm
		.releaseTaskSession?.(sessionId)
		.catch((error) =>
			log.warn("dialogue.task_session_release_failed", {}, error),
		);
}

/**
 * Cancel the run of a turn that is still going (its job and its model request). The job to flush after the
 * commit is returned, so a running attempt is aborted too.
 */
function cancelRunInTransaction(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
): string | null {
	const run = byId(tx, runId);
	if (!run || !["queued", "running"].includes(run.status)) return null;
	if (run.jobId)
		deps.queue.cancelInTransaction(tx, run.jobId, "cancel_requested");
	const current = byId(tx, runId);
	if (current && ["queued", "running"].includes(current.status))
		endRun(deps, tx, current, "cancelled", "cancel_requested");
	return run.jobId;
}

/**
 * Withdraw every turn of a session that has not ended (the one holding the work and any queued behind it).
 * Returns the jobs and runs to abort after the commit.
 */
export function cancelSessionRuns(
	deps: DialogueDeps,
	tx: Database,
	sessionId: string,
	/** A run that is settling right now and ends by itself. */
	except?: string,
): { flush: string[]; runs: string[] } {
	const flush: string[] = [];
	const runs: string[] = [];
	for (const entry of unfinishedSessionRuns(tx, sessionId)) {
		if (entry.id === except) continue;
		const job = cancelRunInTransaction(deps, tx, entry.id);
		if (job) flush.push(job);
		runs.push(entry.id);
	}
	return { flush, runs };
}

/** After the commit: abort what was cancelled in the transaction. */
export function flushCancelled(
	deps: DialogueDeps,
	jobIds: readonly string[],
	runIds: readonly string[],
) {
	const jobs = jobIds.filter(Boolean);
	if (jobs.length) deps.queue.flushCancellations(jobs);
	for (const runId of runIds)
		void deps.larm.cancelSubject?.(runId)?.catch(() => undefined);
}

/** The session as the screen and the model see it: the stored row plus the domain's current work state. */
export function sessionView(
	deps: DialogueDeps,
	tx: Database,
	record: SessionRecord,
): SpecialistSession {
	const work = deps.specialist?.workStateInTransaction(
		tx,
		record.adapterRef,
		record.workRef,
	);
	return {
		id: record.id,
		conversationId: record.conversationId,
		toolchainId: record.toolchainId,
		toolchainRevisionId: record.toolchainRevisionId,
		title: record.title,
		artifactRevisionId: record.artifactRevisionId,
		adapterRef: record.adapterRef,
		workRef: record.workRef,
		state: record.state,
		endReason: record.endReason,
		revision: record.revision,
		epoch: record.epoch,
		activeRunId: record.activeRunId,
		dirty: work?.dirty ?? false,
		busy: work?.busy ?? false,
		label: work?.label ?? record.label,
		expiresAt: record.expiresAt,
		pendingSwitch: record.pendingSwitch,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/** Whether ending with this reason requires the work to be clean (it was handed back or closed, not dropped). */
const keepsSaved = (reason: SpecialistEndReason) =>
	reason === "closed" || reason === "returned";

/**
 * End a session in the caller's transaction: stop the turn still going, end the domain's work and mark the
 * session ended. Throws what the work's end throws (`work_busy`, `work_unsaved`, ...). Returns the jobs to flush.
 */
export function endSessionInTransaction(
	deps: DialogueDeps,
	tx: Database,
	record: SessionRecord,
	reason: SpecialistEndReason,
	except?: string,
): { flush: string[]; runs: string[] } {
	const port = deps.specialist!;
	const flush: string[] = [];
	const runs: string[] = [];
	const cancelled = cancelSessionRuns(deps, tx, record.id, except);
	flush.push(...cancelled.flush);
	runs.push(...cancelled.runs);
	const work = port.workStateInTransaction(
		tx,
		record.adapterRef,
		record.workRef,
	);
	if (work)
		port.endWorkInTransaction(
			tx,
			record.adapterRef,
			record.workRef,
			keepsSaved(reason) ? "close" : "discard",
		);
	patchSession(
		tx,
		record.id,
		{
			state: "ended",
			endReason: reason,
			closingReason: null,
			activeRunId: null,
			pendingSwitch: null,
			label: work?.label ?? record.label,
			bump: true,
		},
		deps.clock(),
	);
	releaseProviderSession(deps, record.id);
	return { flush, runs };
}

/**
 * End a session, or when the domain refuses record `closing` so a later sweep retries the same end: the
 * attempt's own writes are rolled back first, so a domain that still holds the work is never marked ended.
 */
export function endOrMarkClosing(
	deps: DialogueDeps,
	tx: Database,
	record: SessionRecord,
	reason: SpecialistEndReason,
	except?: string,
): { state: "ended" | "closing"; flush: string[]; runs: string[] } {
	const savepoint = "dialogue_specialist_end";
	tx.exec(`SAVEPOINT ${savepoint}`);
	try {
		const done = endSessionInTransaction(deps, tx, record, reason, except);
		tx.exec(`RELEASE ${savepoint}`);
		return { state: "ended", ...done };
	} catch (error) {
		tx.exec(`ROLLBACK TO ${savepoint}`);
		tx.exec(`RELEASE ${savepoint}`);
		const code = safeCode(error, "close_failed");
		log.warn("dialogue.specialist_close_failed", {
			sessionId: record.id,
			reason: code,
			attempt: record.closeFailures + 1,
		});
		patchSession(
			tx,
			record.id,
			{
				state: "closing",
				closingReason: reason,
				closeFailures: record.closeFailures + 1,
				bump: record.state !== "closing",
			},
			deps.clock(),
		);
		return { state: "closing", flush: [], runs: [] };
	}
}

/**
 * Why a turn may not go on (a code), or null: the session is this turn's addressee only while it is
 * active, holds this run, was not re-addressed since the turn was accepted, and has not expired.
 */
export function turnRefusal(
	session: SessionRecord | null,
	runId: string,
	epoch: number,
	now: string,
): string | null {
	if (!session || session.state !== "active") return "specialist_session_ended";
	if (sessionExpired(session, now)) return "specialist_session_expired";
	if (session.epoch !== epoch) return "specialist_session_changed";
	if (session.activeRunId !== runId) return "specialist_session_changed";
	return null;
}

/** Specialist dialogue never reaches memory nor the main agent's context while it belongs to the session. */
export function blockSpecialistMessages(
	deps: Pick<DialogueDeps, "memory">,
	tx: Database,
	conversationId: string,
	messageIds: readonly string[],
) {
	deps.memory?.blockMessagesInTransaction(tx, {
		conversationId,
		messageIds,
		reason: "specialist_dialogue",
	});
}

/** Cancellations made while a queue job settles: flushed when that settlement commits (`afterCommit`). */
const deferred = new WeakMap<object, { jobs: string[]; runs: string[] }>();
export function deferFlush(
	deps: DialogueDeps,
	cancelled: { flush: string[]; runs: string[] },
) {
	if (!cancelled.flush.length && !cancelled.runs.length) return;
	const pending = deferred.get(deps) ?? { jobs: [], runs: [] };
	pending.jobs.push(...cancelled.flush);
	pending.runs.push(...cancelled.runs);
	deferred.set(deps, pending);
}
export function flushDeferred(deps: DialogueDeps) {
	const pending = deferred.get(deps);
	if (!pending) return;
	deferred.delete(deps);
	flushCancelled(deps, pending.jobs, pending.runs);
}
