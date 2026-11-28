import type { Database } from "bun:sqlite";
import type {
	GoalAttempt,
	GoalProgress,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import {
	createLedger,
	type LlmPort as ThoughtPlanLlm,
} from "eumenes-thought-plan";
import { z } from "zod";
import type { HandlerDefinition } from "../../domains/queue";
import { getLogger } from "../../infrastructure/logger";
import {
	continueAfterDesignFailure,
	invalidGoalCriterionQuote,
	type AdvanceGoalProgress,
	type Designed,
	type GoalDesignPreparation,
} from "./goal-design-documents";
import { goalTerminal, goalPollMs, goalSlotBusy } from "./goal-receipts";
import {
	goalAccess,
	goalEditAvailabilityWatch,
	type prepareGoalSnapshot,
} from "./goal-progress-context";
import {
	cycleOf,
	deliberateGoal,
	answeredRefs,
	budgetOf,
	stepOffered,
	withCycle,
	type Deliberation,
	type GoalCycle,
} from "./goal-deliberation";
import { thoughtCounted } from "./goal-thought-budget";
import type { GoalProgressPorts } from "./goal-progress";

const log = getLogger("agency");

export const GOAL_ADVANCE_KIND = "agency.goal.advance";
const payloadSchema = z.strictObject({
	principal: z.string().min(1),
	goalId: z.string().min(1),
	goalRevision: z.number().int().positive(),
	progressVersion: z.number().int().positive(),
});
export type Payload = z.infer<typeof payloadSchema>;
type Snapshot = ReturnType<typeof prepareGoalSnapshot>;
type VerifyInput = Parameters<GoalStore["recordGoalChecksInTransaction"]>[3];
export type CheckOutcome = VerifyInput["checks"];
type Prepared =
	| {
			kind: "decide";
			snapshot: Snapshot;
			cycle: GoalCycle;
			verificationFailed: boolean;
			answered: readonly string[];
	  }
	| { kind: "deferred"; untilMs: number }
	| { kind: "design"; preparation: GoalDesignPreparation }
	| { kind: "verify"; verify: (signal: AbortSignal) => Promise<CheckOutcome> }
	| { kind: "receipt" | "wake" | "unavailable" | "suspended" | "recheck" };
type Result =
	| { kind: "decide"; deliberation: Deliberation }
	| { kind: "deferred"; untilMs: number }
	| { kind: "design"; designed: Designed }
	| { kind: "verify"; checks: CheckOutcome }
	| { kind: "receipt" | "wake" | "unavailable" | "suspended" | "recheck" };

type GoalAdvanceOps = {
	advance: AdvanceGoalProgress;
	claimRow: (db: Database, key: Payload, jobId: string) => GoalProgress | null;
	finishReceipt: (db: Database, row: GoalProgress, jobId: string) => void;
	pendingParkedReceipt: (db: Database, row: GoalProgress) => GoalAttempt | null;
	now: () => number;
	problem: (
		db: Database,
		row: GoalProgress,
		note: string,
		jobId: string,
		cycle?: Partial<GoalCycle>,
	) => void;
	retryReceipt: (db: Database, row: GoalProgress, jobId: string) => void;
	scopeAllowed: (db: Database, row: GoalProgress) => boolean;
	snapshot: (db: Database, row: GoalProgress) => Snapshot | undefined;
	stopped: (db: Database, row: GoalProgress) => boolean;
	slotTurn: (db: Database, row: GoalProgress) => boolean;
	submit: (db: Database, row: GoalProgress, jobId?: string) => void;
	wake: () => void;
};

function prepareGoalAdvance(
	ports: GoalProgressPorts,
	ops: Pick<
		GoalAdvanceOps,
		| "claimRow"
		| "pendingParkedReceipt"
		| "stopped"
		| "scopeAllowed"
		| "snapshot"
	>,
	db: Database,
	claim: { payload: Payload; jobId: string },
): ReturnType<
	HandlerDefinition<Payload, Prepared, Result>["prepareInTransaction"]
> {
	const { claimRow, pendingParkedReceipt, stopped, scopeAllowed, snapshot } =
		ops;
	const { goals } = ports;
	const row = claimRow(db, claim.payload, claim.jobId);
	if (!row) return { status: "stale", reason: "goal_snapshot_old" };
	if (
		(row.currentWorkId &&
			(goalTerminal(row) ||
				row.phase === "dispatch" ||
				row.phase === "observing")) ||
		pendingParkedReceipt(db, row)
	)
		return { status: "ready", input: { kind: "receipt" } };
	if (stopped(db, row))
		return { status: "ready", input: { kind: "suspended" } };
	if (!scopeAllowed(db, row)) {
		goals.clearGoalJobInTransaction(db, row, claim.jobId);
		return { status: "stale", reason: "goal_scope_inactive" };
	}
	if (row.phase === "waiting")
		return { status: "ready", input: { kind: "wake" } };
	const stale = ports.staleVerificationEvidence?.(db, row);
	if (stale?.size) return { status: "ready", input: { kind: "recheck" } };
	if (row.phase === "verifying") {
		const verify = ports.verify?.(db, row);
		return {
			status: "ready",
			input: verify ? { kind: "verify", verify } : { kind: "unavailable" },
		};
	}
	if (row.phase !== "ready")
		return { status: "stale", reason: "goal_not_ready" };
	// Thinking (a design or a turn) waits for the host to be idle; what was already decided is not thinking.
	const idleAt = ports.idleUntil?.() ?? null;
	if (idleAt !== null && !cycleOf(row).pending)
		return { status: "ready", input: { kind: "deferred", untilMs: idleAt } };
	if (!row.state.design) {
		const preparation = ports.prepareDesign?.(db, row);
		if (preparation)
			return { status: "ready", input: { kind: "design", preparation } };
	}
	const prepared = snapshot(db, row);
	return prepared
		? {
				status: "ready",
				input: {
					kind: "decide",
					snapshot: prepared,
					cycle: cycleOf(row),
					verificationFailed: row.state.problem === "verification_incomplete",
					answered: answeredRefs(row),
				},
			}
		: { status: "stale", reason: "goal_not_current" };
}

/** The goal's state with what a turn thought kept (its session and count), when its step is not taken. */
function keepingThought(progress: GoalProgress, result: Result) {
	const thought =
		result.kind === "decide" ? result.deliberation.cycle : undefined;
	return thought
		? withCycle(progress.state, { ...cycleOf(progress), ...budgetOf(thought) })
		: progress.state;
}

/** A turn whose run reached the model is not tried again by the queue: it counts once, and the goal waits. */
const classify = (error: unknown) =>
	error instanceof Error &&
	(error.message === invalidGoalCriterionQuote || thoughtCounted(error.message))
		? ("fail" as const)
		: ("retry" as const);

export function createGoalAdvanceHandler(
	ports: GoalProgressPorts,
	ops: GoalAdvanceOps,
): HandlerDefinition<Payload, Prepared, Result> {
	const { goals } = ports;
	const {
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
	} = ops;
	return {
		kind: GOAL_ADVANCE_KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "replay_safe",
		prepareInTransaction: (db, claim) =>
			prepareGoalAdvance(ports, ops, db, claim),
		execute: (input, { signal }) => executeGoalAdvance(ports, input, signal),
		classify,
		settleInTransaction(db, claim, input, settled) {
			const row = claimRow(db, claim.payload, claim.jobId);
			if (!row) return "stale";
			if (settled.type === "retry") return "applied";
			goals.clearGoalJobInTransaction(db, row, claim.jobId);
			if (settled.type !== "success") {
				const reason =
					settled.type === "expired"
						? "goal_decision_expired"
						: settled.errorCode;
				if (row.currentWorkId || pendingParkedReceipt(db, row))
					retryReceipt(db, row, claim.jobId);
				else if (input?.kind === "design") {
					if (!scopeAllowed(db, row)) return "stale";
					continueAfterDesignFailure(
						advance,
						db,
						row,
						reason,
						input.preparation,
						claim.jobId,
					);
				} else problem(db, row, reason, claim.jobId);
				return "applied";
			}
			const result = settled.result;
			if (result.kind === "deferred") {
				advance(
					db,
					row,
					(current) => ({
						phase: current.phase,
						state: current.state,
						dueAtMs: result.untilMs,
					}),
					claim.jobId,
				);
				return "applied";
			}
			if (result.kind === "receipt") {
				finishReceipt(db, row, claim.jobId);
				return "applied";
			}
			if (result.kind === "suspended" || stopped(db, row)) {
				advance(
					db,
					row,
					(current) => ({
						phase: current.phase,
						state: keepingThought(current, result),
						dueAtMs: current.dueAtMs,
					}),
					claim.jobId,
				);
				return "applied";
			}
			if (!scopeAllowed(db, row)) return "stale";
			const access = goalAccess(row);
			if (result.kind === "recheck") {
				const stale =
					ports.staleVerificationEvidence?.(db, row) ?? new Set<string>();
				advance(
					db,
					row,
					(current) => ({
						phase: "ready",
						state: {
							...current.state,
							next: null,
							criteria: current.state.criteria.map((criterion) =>
								criterion.evidenceRefs.some((ref) => stale.has(ref))
									? {
											...criterion,
											status: "open",
											evidenceRefs: [],
										}
									: criterion,
							),
						},
					}),
					claim.jobId,
				);
			} else if (result.kind === "wake") {
				advance(
					db,
					row,
					(current) => ({
						phase: "ready",
						state: { ...current.state, watch: null, next: null },
					}),
					claim.jobId,
				);
			} else if (result.kind === "design") {
				const designed = result.designed;
				if ("blocked" in designed) {
					continueAfterDesignFailure(
						advance,
						db,
						row,
						designed.blocked,
						input?.kind === "design" ? input.preparation : null,
						claim.jobId,
					);
				} else {
					const saved = goals.adoptGoalCriteriaInTransaction(db, access, row, {
						...designed,
						expectedVersion: row.progressVersion,
					});
					if (saved.status === "applied") {
						ports.saveDesign?.(db, saved.progress, designed);
						submit(db, saved.progress, claim.jobId);
					} else problem(db, row, "goal_design_conflict", claim.jobId);
				}
			} else if (result.kind === "verify") {
				const current = (tx: Database, progress: GoalProgress) =>
					ports.verificationCurrent?.(tx, progress, result.checks) === true;
				const finished = goals.recordGoalChecksInTransaction(db, access, row, {
					expectedVersion: row.progressVersion,
					checks: result.checks,
					current,
				});
				if (!finished)
					problem(db, row, "goal_verification_unavailable", claim.jobId);
				else if (
					finished.state.criteria.every(({ status }) => status === "passed")
				) {
					const complete = goals.completeInTransaction(db, access, row, {
						expectedVersion: finished.progressVersion,
						current,
						text:
							ports.report?.(finished) ??
							finished.state.criteria.map(({ text }) => text).join("\n"),
					});
					if (complete.status !== "applied")
						throw new Error("goal_completion_conflict");
				} else submit(db, finished, claim.jobId);
			} else if (result.kind === "decide" && input?.kind === "decide") {
				const current = snapshot(db, row);
				if (
					!current ||
					current.context.contextId !== input.snapshot.context.contextId
				) {
					// The goal moved on meanwhile: the step is not taken, but what was thought is kept.
					advance(
						db,
						row,
						(latest) => ({
							phase: "ready",
							state: keepingThought(latest, result),
						}),
						claim.jobId,
					);
					return "stale";
				}
				const deliberation = result.deliberation;
				if (deliberation.kind === "pause") {
					problem(
						db,
						row,
						deliberation.reason,
						claim.jobId,
						deliberation.cycle,
					);
					return "applied";
				}
				const step = deliberation.step;
				const capability =
					step.kind === "act" &&
					current.capabilities.find(({ ref }) => ref === step.capabilityRef);
				const watch =
					step.kind === "wait" &&
					current.watches.find(({ ref }) => ref === step.watchRef);
				const retryWhileAsking =
					step.kind === "ask"
						? current.watches.find(
								({ ref }) => ref === goalEditAvailabilityWatch,
							)
						: undefined;
				const accepted =
					step.kind === "act" && !slotTurn(db, row)
						? ({ status: "busy" } as const)
						: goals.applyDecisionInTransaction(db, access, row, step, {
								nowMs: now(),
								contextId: current.context.contextId,
								current: () => true,
								...(capability
									? {
											act: {
												owner: capability.owner,
												bindingRevisionId: capability.bindingRevisionId,
												permitId: capability.permitId,
												permitRevision: capability.permitRevision,
												operationRef: capability.operationRef,
											},
										}
									: {}),
								...(watch ? { watch } : {}),
								...(retryWhileAsking ? { retryWhileAsking } : {}),
								...(step.kind === "ask" && {
									questionSources: current.input.sources,
								}),
								...(current.context.configuration && {
									configurationRef: current.context.configuration.ref,
								}),
								canProceedWhileAsking:
									current.capabilities.length > 0 &&
									current.context.criteria.some(
										({ id, status }) =>
											status === "open" && !step.criterionIds.includes(id),
									),
							});
				if (accepted.status === "applied") {
					// The rest of the chosen method waits for this step's result; a stop count starts again.
					const cycle: GoalCycle = {
						...cycleOf(row),
						...deliberation.cycle,
						pending: null,
						parks: 0,
					};
					const kept = goals.transitionProgressInTransaction(
						db,
						access,
						accepted.progress,
						accepted.progress.progressVersion,
						(latest) => ({
							phase: latest.phase,
							dueAtMs: latest.dueAtMs,
							state: withCycle(latest.state, cycle),
						}),
					);
					submit(db, kept ?? accepted.progress, claim.jobId);
				} else if (accepted.status === "busy")
					advance(
						db,
						row,
						(latest) => ({
							phase: "waiting",
							dueAtMs: now() + goalPollMs,
							state: {
								...withCycle(latest.state, {
									...cycleOf(latest),
									...deliberation.cycle,
									pending: deliberation.planned,
								}),
								next: step,
								problem: goalSlotBusy,
							},
						}),
						claim.jobId,
					);
				else if (accepted.status !== "replayed")
					problem(
						db,
						row,
						"goal_decision_" + accepted.status,
						claim.jobId,
						deliberation.cycle && budgetOf(deliberation.cycle),
					);
			} else problem(db, row, "goal_worker_unavailable", claim.jobId);
			return "applied";
		},
		afterCommit: wake,
		cancelInTransaction(db, job) {
			goals.clearGoalJobInTransaction(db, job.payload, job.jobId);
		},
	};
}

async function executeGoalAdvance(
	ports: GoalProgressPorts,
	input: Prepared,
	signal: AbortSignal,
): Promise<Result> {
	if (input.kind === "decide") {
		const deliberation = await (ports.deliberate ?? deliberateGoal)({
			// The same call shape; the two packages only carry their own zod type definitions.
			llm: ports.llm(
				input.snapshot.context.progressVersion,
			) as unknown as ThoughtPlanLlm,
			ledger: ports.thoughtLedger ?? createLedger(null, "off"),
			snapshot: input.snapshot,
			cycle: input.cycle,
			signal,
			verificationFailed: input.verificationFailed,
			answered: input.answered,
		});
		// One line per turn: which goal, what it concluded, nothing of the goal's text.
		log.info("agency.goal_cycle", {
			subjectId: input.snapshot.context.goal.id,
			workRevision: input.snapshot.context.progressVersion,
			decision: deliberation.kind === "step" ? deliberation.step.kind : "pause",
			...(deliberation.kind === "pause" && { reason: deliberation.reason }),
			...(deliberation.cycle?.runId && { runId: deliberation.cycle.runId }),
			// How many rounds this autonomous run has thought so far.
			count: deliberation.cycle?.thoughts ?? input.cycle.thoughts,
		});
		// A step outside what the turn was shown is never applied; the queue tries the turn again.
		if (
			deliberation.kind === "step" &&
			!stepOffered(input.snapshot.context, deliberation.step)
		)
			throw new Error("unoffered_ref");
		return { kind: "decide", deliberation };
	}
	if (input.kind === "design")
		return { kind: "design", designed: await input.preparation.run(signal) };
	if (input.kind === "verify")
		return { kind: "verify", checks: await input.verify(signal) };
	return input;
}
