import type { Database } from "bun:sqlite";
import type { LlmPort } from "eumenes-agency";
import type {
	GoalAccess,
	GoalAttempt,
	GoalObservation,
	GoalPermit,
	GoalProgress,
	GoalProgressKey,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { type Ledger } from "eumenes-thought-plan";
import type { QueueService } from "../../domains/queue";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	resumeLegacyDesignFailure,
	type Designed,
	type GoalDesignPreparation,
} from "./goal-design-documents";
import { createGoalRecovery, openJob, scheduled } from "./goal-recovery";
import {
	createGoalReceipts,
	goalHasParkedWork,
	goalTerminal,
	slotTurnByPriority,
} from "./goal-receipts";
import {
	goalAccess,
	goalDigest,
	prepareGoalSnapshot,
	type GoalCheckCandidate,
	type GoalSurface,
} from "./goal-progress-context";
import {
	cycleOf,
	deliberateGoal,
	parkDelayMs,
	withCycle,
} from "./goal-deliberation";

import {
	createGoalAdvanceHandler,
	GOAL_ADVANCE_KIND,
	type Payload,
	type CheckOutcome,
} from "./goal-advance-handler";

export { GOAL_ADVANCE_KIND } from "./goal-advance-handler";

const log = getLogger("agency");

const scope = "agency-goals";
export type OwnerResult =
	| { status: "unknown" | "absent" }
	| { status: "refused"; reason: string }
	| { status: "known"; observation: GoalObservation };
export interface GoalOwnerPort {
	startInTransaction(
		db: Database,
		progress: GoalProgress,
		attempt: GoalAttempt,
		permit: GoalPermit,
	): OwnerResult;
	lookupInTransaction(
		db: Database,
		progress: GoalProgress,
		attempt: GoalAttempt,
	): OwnerResult;
	cancelInTransaction(
		db: Database,
		progress: GoalProgress,
		attempt: GoalAttempt,
	): boolean;
	readonly answerWhileRunning?: true;
	answerInTransaction?(
		db: Database,
		progress: GoalProgress,
		attempt: GoalAttempt,
		permit: GoalPermit,
		question: { ref: string; messageId: string; answer: string },
	): void;
	wake(): void;
}
export interface GoalProgressPorts {
	readonly store: SqliteStore;
	readonly goals: GoalStore;
	readonly queue: QueueService;
	readonly llm: (progressVersion: number) => LlmPort;
	readonly surface: (
		db: Database,
		progress: GoalProgress,
		permit: GoalPermit | null,
	) => GoalSurface;
	readonly checks?: (
		db: Database,
		progress: GoalProgress,
	) => readonly GoalCheckCandidate[];
	readonly sourcesCurrent: (
		db: Database,
		progress: GoalProgress,
		sources: readonly string[],
	) => boolean;
	readonly sourceText?: (db: Database, ref: string) => string | null;
	readonly enabled: (db: Database) => boolean;
	readonly owners: Readonly<Record<string, GoalOwnerPort>>;
	readonly prepareDesign?: (
		db: Database,
		progress: GoalProgress,
	) => GoalDesignPreparation | null;
	readonly saveDesign?: (
		db: Database,
		progress: GoalProgress,
		designed: Exclude<Designed, { blocked: string }>,
	) => void;
	readonly verify?: (
		db: Database,
		progress: GoalProgress,
	) => ((signal: AbortSignal) => Promise<CheckOutcome>) | null;
	readonly staleVerificationEvidence?: (
		db: Database,
		progress: GoalProgress,
	) => ReadonlySet<string>;
	readonly onConfigurationChange?: (listener: () => void) => () => void;
	readonly legacyReadPolicy?: (
		db: Database,
		progress: GoalProgress,
	) => GoalProgress;
	readonly reconcileConfiguration?: (
		db: Database,
		progress: GoalProgress,
	) => GoalProgress;
	readonly deliveryConversationOf?: (
		db: Database,
		sourceRef: string,
	) => string | null;
	readonly verificationCurrent?: (
		db: Database,
		progress: GoalProgress,
		checks: CheckOutcome,
	) => boolean;
	readonly report?: (progress: GoalProgress) => string;
	readonly legacyAccess?: GoalAccess;
	readonly nowMs?: () => number;
	/** Where each turn's thought plan records its stages (the host's SQLite); off when absent. */
	readonly thoughtLedger?: Ledger;
	/**
	 * null while the host is idle (nobody is being served in the foreground and the last foreground request
	 * ended long enough ago); otherwise when idling can begin. A goal thinks only while the host is idle.
	 */
	readonly idleUntil?: () => number | null;
	/** One turn of thinking; the thought plan (`deliberateGoal`) unless a test supplies its own. */
	readonly deliberate?: typeof deliberateGoal;
}

export function createGoalProgress(ports: GoalProgressPorts) {
	const { goals, queue } = ports;
	const now = ports.nowMs ?? Date.now;
	const cancelled = new Set<string>();
	const control = (db: Database, row: GoalProgress) =>
		goals.goalScopeControlInTransaction(db, goalAccess(row), row.ledgerScope);
	const stopped = (db: Database, row: GoalProgress) =>
		!ports.enabled(db) || (control(db, row)?.allUntilMs ?? 0) > now();
	const slotTurn = (db: Database, row: GoalProgress) =>
		slotTurnByPriority(db, ports, row, stopped);
	const scopeAllowed = (db: Database, row: GoalProgress) =>
		!row.state.sourceRef ||
		ports.sourcesCurrent(db, row, [row.state.sourceRef]);

	function snapshot(db: Database, row: GoalProgress) {
		const goal = goals.currentGoalInTransaction(
			db,
			goalAccess(row),
			row.goalId,
		);
		return (
			goal &&
			prepareGoalSnapshot(
				db,
				{
					...ports,
					ownerAvailable: (owner) => Object.hasOwn(ports.owners, owner),
					nowMs: now(),
				},
				row,
				goal,
			)
		);
	}
	function submit(db: Database, row: GoalProgress, claimId?: string) {
		if (row.jobId && row.jobId !== claimId) {
			const previous = queue.getInTransaction(db, row.jobId);
			if (openJob(previous?.state)) {
				queue.cancelInTransaction(db, row.jobId, "goal_progress_advanced");
				cancelled.add(row.jobId);
			}
			goals.clearGoalJobInTransaction(db, row, row.jobId);
		}
		const cleanup =
			(goalTerminal(row) || stopped(db, row)) &&
			goalHasParkedWork(db, goals, row);
		if (
			!row.needsEnqueue ||
			(!ports.enabled(db) && row.currentWorkId === null && !cleanup)
		)
			return;
		const payload: Payload = {
			principal: row.principal,
			goalId: row.goalId,
			goalRevision: row.goalRevision,
			progressVersion: row.progressVersion,
		};
		const pausedUntil =
			row.currentWorkId || cleanup ? 0 : (control(db, row)?.allUntilMs ?? 0);
		try {
			const { job } = queue.enqueueInTransaction(db, {
				scope,
				kind: GOAL_ADVANCE_KIND,
				payloadVersion: 1,
				payload,
				lane: "background",
				maxAttempts: 3,
				subjectRef: row.goalId,
				dedupeKey: goalDigest(payload),
				concurrencyKey: JSON.stringify([row.principal, row.goalId]),
				availableAtMs: Math.max(row.dueAtMs ?? now(), pausedUntil),
			});
			if (
				!openJob(job.state) ||
				!goals.bindGoalJobInTransaction(db, row, row.progressVersion, job.id)
			)
				throw new Error("goal_queue_reservation_conflict");
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "queue_full")
				throw error;
		}
	}
	function advance(
		db: Database,
		row: GoalProgress,
		next: Parameters<GoalStore["transitionProgressInTransaction"]>[4],
		claimId?: string,
	) {
		const updated = goals.transitionProgressInTransaction(
			db,
			goalAccess(row),
			row,
			row.progressVersion,
			next,
		);
		if (updated) submit(db, updated, claimId);
		return updated;
	}
	function wake() {
		if (cancelled.size) {
			queue.flushCancellations([...cancelled]);
			cancelled.clear();
		}
		queue.wake();
		for (const owner of Object.values(ports.owners)) owner.wake();
	}
	function problem(
		db: Database,
		row: GoalProgress,
		note: string,
		claimId: string,
	) {
		// The step is cleared below; this line keeps which step could not go on, for the goal's later reading.
		log.warn("agency.goal_parked", {
			reason: note,
			jobId: claimId,
			subjectId: row.goalId,
			kind: row.state.next?.kind ?? "none",
			workRevision: row.progressVersion,
		});
		advance(
			db,
			row,
			(current) => ({
				phase: "waiting",
				// Looked at again later even if nothing changes: 1 hour, then twice as long each time, up to 24 hours.
				dueAtMs: now() + parkDelayMs(cycleOf(current).parks),
				state: {
					...withCycle(current.state, {
						...cycleOf(current),
						parks: cycleOf(current).parks + 1,
						pending: null,
					}),
					problem: note,
					next: null,
					watch: {
						ref: "configuration-or-input",
						producer: "goal-configuration",
						condition: "推論経路、利用可能な能力、または資料が更新される",
						dueAtMs: null,
					},
				},
			}),
			claimId,
		);
	}
	const {
		acceptObservation,
		finishReceipt,
		pendingParkedReceipt,
		recoverParked,
		retryReceipt,
	} = createGoalReceipts(ports, {
		advance,
		submit,
		problem,
		now,
		stopped,
		scopeAllowed,
		slotTurn,
	});

	function claimRow(db: Database, key: Payload, jobId: string) {
		const row = goals.claimGoalProgressInTransaction(
			db,
			key,
			key.progressVersion,
			jobId,
		);
		if (!row) return null;
		return (goalTerminal(row) &&
			(row.currentWorkId !== null || goalHasParkedWork(db, goals, row))) ||
			goals.activeProgressInTransaction(db, goalAccess(row), row)
			? row
			: null;
	}

	queue.registerHandler(
		createGoalAdvanceHandler(ports, {
			advance,
			claimRow,
			finishReceipt,
			pendingParkedReceipt,
			now,
			problem,
			retryReceipt,
			scopeAllowed,
			snapshot,
			stopped,
			slotTurn,
			submit,
			wake,
		}),
	);

	const recovery = createGoalRecovery(ports, {
		advance,
		scopeAllowed,
		slotTurn,
		stopped,
		submit,
		wake,
		now,
		scope,
		deferReceipt: retryReceipt,
		pendingParkedReceipt,
		recoverParked,
		resumeDesignFailure: (db, row) =>
			resumeLegacyDesignFailure(ports, { advance, snapshot }, db, row),
	});

	return {
		...recovery,
		wake,
		submitInTransaction: submit,
		notifyWorkInTransaction: acceptObservation,
		rescheduleScopeInTransaction(
			db: Database,
			access: GoalAccess,
			ledgerScope: string,
		) {
			for (const row of goals.progressRowsInTransaction(db)) {
				const parked = goalHasParkedWork(db, goals, row);
				if (
					row.principal !== access.principal ||
					row.ledgerScope !== ledgerScope ||
					(!scheduled(row) && row.currentWorkId === null && !parked)
				)
					continue;
				advance(db, row, (current) => ({
					phase: current.phase,
					state: current.state,
					dueAtMs:
						current.currentWorkId || (parked && stopped(db, current))
							? now()
							: current.dueAtMs,
				}));
			}
		},

		notifyDocumentInTransaction(
			db: Database,
			key: GoalProgressKey,
			access: GoalAccess,
			evidence: GoalObservation,
			current: (db: Database, progress: GoalProgress) => boolean,
			retainWhileWaiting = false,
		) {
			const result = goals.observeInTransaction(db, access, key, evidence, {
				current,
			});
			if (result.status === "applied") submit(db, result.progress);
			if (result.status !== "stale" || !retainWhileWaiting || evidence.attempt)
				return result.status;
			const live = goals.activeProgressInTransaction(db, access, key);
			if (!live || live.phase !== "waiting") return "stale";
			if (!current(db, live)) return "forbidden";
			const entries = new Map(
				live.state.evidence.map((item) => [item.ref, item]),
			);
			const changed = new Set<string>();
			for (const item of evidence.evidence ?? []) {
				const previous = entries.get(item.ref);
				if (previous?.version === item.version) {
					if (previous.digest !== item.digest) return "conflict";
				} else {
					entries.set(item.ref, item);
					changed.add(item.ref);
				}
			}
			if (!changed.size) return "replayed";
			return advance(db, live, (row) => ({
				phase: row.phase,
				dueAtMs: row.dueAtMs,
				state: {
					...row.state,
					evidence: [...entries.values()],
					criteria: row.state.criteria.map((criterion) =>
						criterion.evidenceRefs.some((ref) => changed.has(ref))
							? { ...criterion, status: "open", evidenceRefs: [] }
							: criterion,
					),
				},
			}))
				? "applied"
				: "stale";
		},
	};
}
