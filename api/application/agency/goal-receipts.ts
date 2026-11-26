import type { Database } from "bun:sqlite";
import type {
	GoalAttempt,
	GoalObservation,
	GoalProgress,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { goalAccess } from "./goal-progress-context";
import type { GoalProgressPorts } from "./goal-progress";

export const goalPollMs = 5_000;
export const goalSlotBusy = "goal_work_slot_busy";
export const goalTerminal = (row: GoalProgress) =>
	row.phase === "completed" ||
	row.phase === "withdrawn" ||
	row.phase === "superseded";

const answerFor = (row: GoalProgress, attemptId?: string) =>
	row.state.questions.find(
		(item) =>
			item.owner &&
			(!attemptId || item.owner.attemptId === attemptId) &&
			item.answeredBy &&
			!item.delivered,
	);

export const goalHasParkedWork = (
	db: Database,
	goals: GoalStore,
	row: GoalProgress,
) => goals.parkedGoalAttemptsInTransaction(db, goalAccess(row), row).length > 0;

export function slotTurnByPriority(
	db: Database,
	ports: GoalProgressPorts,
	row: GoalProgress,
	stopped: (db: Database, row: GoalProgress) => boolean,
) {
	const { goals } = ports;
	const candidates = goals
		.progressRowsInTransaction(db)
		.filter(
			(other) =>
				other.principal === row.principal &&
				(other.goalId === row.goalId ||
					other.state.problem === goalSlotBusy ||
					!!answerFor(other)) &&
				!stopped(db, other) &&
				!!goals.activeProgressInTransaction(db, goalAccess(other), other),
		);
	const priority = (item: GoalProgress) =>
		goals.currentGoalInTransaction(db, goalAccess(item), item.goalId)
			?.priority ?? 0;
	const first = candidates.sort((a, b) => priority(b) - priority(a)).at(0);
	return !first || first.goalId === row.goalId;
}

export function createGoalReceipts(
	ports: GoalProgressPorts,
	ops: {
		advance(
			db: Database,
			row: GoalProgress,
			next: Parameters<GoalStore["transitionProgressInTransaction"]>[4],
			claimId?: string,
		): GoalProgress | null;
		submit(db: Database, row: GoalProgress, claimId?: string): void;
		problem(
			db: Database,
			row: GoalProgress,
			note: string,
			claimId: string,
		): void;
		now(): number;
		stopped(db: Database, row: GoalProgress): boolean;
		scopeAllowed(db: Database, row: GoalProgress): boolean;
		slotTurn(db: Database, row: GoalProgress): boolean;
	},
) {
	const { goals } = ports;
	const { advance, submit, problem, now, stopped, scopeAllowed, slotTurn } =
		ops;
	function permitFor(db: Database, row: GoalProgress, attempt: GoalAttempt) {
		const permit = goals.goalPermitInTransaction(
			db,
			goalAccess(row),
			row,
			attempt.permitId,
		);
		if (
			!permit ||
			!attempt.step.request ||
			permit.revoked ||
			permit.revision !== attempt.permitRevision ||
			(permit.scope.expiresAtMs !== null && permit.scope.expiresAtMs <= now())
		)
			return null;
		if (
			permit.scope.basis.kind === "message" &&
			!ports.sourcesCurrent(db, row, permit.scope.basis.sourceRefs)
		)
			return null;
		const dependencies = row.state.evidence.filter((item) =>
			attempt.step.evidenceRefs.includes(item.ref),
		);
		if (
			dependencies.length !==
				new Set(
					attempt.step.evidenceRefs.filter(
						(ref) => ref !== row.state.sourceRef,
					),
				).size ||
			!ports.sourcesCurrent(
				db,
				row,
				dependencies.flatMap(({ sources }) => sources ?? []),
			)
		)
			return null;
		return scopeAllowed(db, row) && !stopped(db, row) ? permit : null;
	}
	function acceptObservation(
		db: Database,
		row: GoalProgress,
		evidence: GoalObservation,
		claimId?: string,
	) {
		const result = goals.observeInTransaction(
			db,
			goalAccess(row),
			row,
			evidence,
			{
				current: (tx, live, attempt) =>
					!!attempt && permitFor(tx, live, attempt) !== null,
				dueAtMs:
					evidence.attempt?.outcome === "running" ? now() + goalPollMs : null,
			},
		);
		if (result.status === "applied") submit(db, result.progress, claimId);
		return result.status;
	}
	function pendingParkedReceipt(db: Database, row: GoalProgress) {
		if (row.currentWorkId) return null;
		return (
			goals
				.parkedGoalAttemptsInTransaction(db, goalAccess(row), row)
				.find((attempt) => {
					const question = row.state.questions.find(
						(item) => item.owner?.attemptId === attempt.id && !item.delivered,
					);
					return (
						!permitFor(db, row, attempt) ||
						!question?.owner ||
						question.owner.expiresAtMs <= now() ||
						(row.phase !== "verifying" && !!question.answeredBy)
					);
				}) ?? null
		);
	}
	function recoverParked(db: Database, row: GoalProgress) {
		const access = goalAccess(row);
		const normalized = goals.parkReleasedGoalAttemptInTransaction(
			db,
			access,
			row,
		);
		if (normalized) submit(db, normalized);
		for (const attempt of goals.parkedGoalAttemptsInTransaction(
			db,
			access,
			row,
		)) {
			const live = goals.activeProgressInTransaction(db, access, row);
			if (!live || !permitFor(db, live, attempt)) continue;
			const result = ports.owners[attempt.owner]?.lookupInTransaction(
				db,
				live,
				attempt,
			);
			if (result?.status === "known")
				acceptObservation(db, live, result.observation);
		}
	}
	function retryReceipt(db: Database, row: GoalProgress, claimId: string) {
		if (goalTerminal(row)) {
			const next = goals.deferGoalCleanupInTransaction(
				db,
				goalAccess(row),
				row,
				row.progressVersion,
				now() + goalPollMs,
			);
			if (next) submit(db, next, claimId);
			return;
		}
		advance(
			db,
			row,
			(current) => ({
				phase: current.currentWorkId ? "observing" : current.phase,
				dueAtMs: now() + goalPollMs,
				state: current.state,
			}),
			claimId,
		);
	}
	function finishReceipt(db: Database, row: GoalProgress, claimId: string) {
		const access = goalAccess(row);
		const attempt = row.currentWorkId
			? goals.goalAttemptInTransaction(db, access, row, row.currentWorkId)
			: pendingParkedReceipt(db, row);
		if (!attempt) {
			problem(db, row, "goal_attempt_missing", claimId);
			return;
		}
		const owner = ports.owners[attempt.owner];
		const permit = permitFor(db, row, attempt);
		const answer = answerFor(row, attempt.id);
		const answerText =
			answer?.answeredBy && ports.sourceText?.(db, answer.answeredBy);
		const canAnswer =
			answer?.owner &&
			answer.owner.expiresAtMs > now() &&
			answerText &&
			(answer.owner.released ||
				(owner?.answerWhileRunning &&
					row.currentWorkId === answer.owner.attemptId));
		if (!permit || !owner || (!row.currentWorkId && !canAnswer)) {
			if (!owner || !owner.cancelInTransaction(db, row, attempt)) {
				retryReceipt(db, row, claimId);
				return;
			}
			const next = goals.releaseGoalAttemptInTransaction(
				db,
				access,
				row,
				attempt.id,
				owner ? "goal_authority_inactive" : "goal_worker_unavailable",
			);
			if (next) submit(db, next, claimId);
			return;
		}
		if (answer?.answeredBy) {
			if (canAnswer && owner.answerInTransaction) {
				const receipt = owner.lookupInTransaction(db, row, attempt);
				if (
					receipt.status === "known" &&
					receipt.observation.attempt &&
					(attempt.ownerRevision ?? -1) <
						receipt.observation.attempt.ownerRevision
				) {
					if (
						acceptObservation(db, row, receipt.observation, claimId) ===
						"applied"
					)
						return;
				}
				const alreadyHolding =
					answer.owner?.released === false && row.currentWorkId === attempt.id;
				const admission =
					alreadyHolding || slotTurn(db, row)
						? goals.admitGoalAnswerInTransaction(
								db,
								access,
								row,
								attempt.id,
								answer.ref,
							)
						: "busy";
				if (admission === "ready") {
					owner.answerInTransaction(db, row, attempt, permit, {
						ref: answer.ref,
						messageId: answer.answeredBy,
						answer: answerText,
					});
					const delivered = goals.recordGoalAnswerInTransaction(
						db,
						access,
						row,
						answer.ref,
					);
					if (delivered) submit(db, delivered, claimId);
					return;
				}
				if (admission === "busy") {
					retryReceipt(db, row, claimId);
					return;
				}
			}
		}
		let receipt = owner.lookupInTransaction(db, row, attempt);
		if (receipt.status === "absent" && attempt.ownerWorkId === null)
			receipt = owner.startInTransaction(db, row, attempt, permit);
		if (receipt.status === "refused") {
			const next = goals.releaseGoalAttemptInTransaction(
				db,
				access,
				row,
				attempt.id,
				receipt.reason,
			);
			if (next) submit(db, next, claimId);
			return;
		}
		if (receipt.status === "known") {
			const status = acceptObservation(db, row, receipt.observation, claimId);
			if (status === "applied") return;
			if (status === "forbidden" || status === "conflict")
				throw new Error("goal_receipt_conflict");
		}
		// No new receipt version means no additional observation. The next poll still gets its own job.
		retryReceipt(db, row, claimId);
	}

	return {
		acceptObservation,
		finishReceipt,
		pendingParkedReceipt,
		recoverParked,
		retryReceipt,
	};
}
