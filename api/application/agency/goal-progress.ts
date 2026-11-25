import type { Database } from "bun:sqlite";
import type { LlmPort } from "eumenes-agency";
import { decideGoalStep } from "eumenes-agency/agenda";
import type {
	GoalAccess,
	GoalAttempt,
	GoalObservation,
	GoalPermit,
	GoalProgress,
	GoalProgressKey,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { z } from "zod";
import type { HandlerDefinition, QueueService } from "../../domains/queue";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	continueAfterDesignFailure,
	invalidGoalCriterionQuote,
	resumeLegacyDesignFailure,
	type AdvanceGoalProgress,
	type Designed,
	type GoalDesignPreparation,
} from "./goal-design-documents";
import { createGoalRecovery, openJob, scheduled } from "./goal-recovery";
import {
	createGoalReceipts,
	goalHasParkedWork,
	goalTerminal,
	goalPollMs,
	goalSlotBusy,
	slotTurnByPriority,
} from "./goal-receipts";
import {
	goalAccess,
	goalDigest,
	goalEditAvailabilityWatch,
	prepareGoalSnapshot,
	type GoalCheckCandidate,
	type GoalSurface,
} from "./goal-progress-context";

export const GOAL_ADVANCE_KIND = "agency.goal.advance";
const scope = "agency-goals";
const payloadSchema = z.strictObject({
	principal: z.string().min(1),
	goalId: z.string().min(1),
	goalRevision: z.number().int().positive(),
	progressVersion: z.number().int().positive(),
});
type Payload = z.infer<typeof payloadSchema>;
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
	answerInTransaction?(
		db: Database,
		progress: GoalProgress,
		attempt: GoalAttempt,
		permit: GoalPermit,
		question: { ref: string; messageId: string; answer: string },
	): void;
	wake(): void;
}
type Snapshot = ReturnType<typeof prepareGoalSnapshot>;
type Selected = Extract<
	Awaited<ReturnType<typeof decideGoalStep>>,
	{ status: "chosen" }
>;
type VerifyInput = Parameters<GoalStore["recordGoalChecksInTransaction"]>[3];
type CheckOutcome = VerifyInput["checks"];
type Prepared =
	| { kind: "decide"; snapshot: Snapshot }
	| { kind: "design"; preparation: GoalDesignPreparation }
	| { kind: "verify"; verify: (signal: AbortSignal) => Promise<CheckOutcome> }
	| { kind: "receipt" | "wake" | "unavailable" | "suspended" | "recheck" };
type Result =
	| { kind: "decide"; selected: Selected }
	| { kind: "design"; designed: Designed }
	| { kind: "verify"; checks: CheckOutcome }
	| { kind: "receipt" | "wake" | "unavailable" | "suspended" | "recheck" };

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
	) => Extract<Prepared, { kind: "verify" }>["verify"] | null;
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
		advance(
			db,
			row,
			(current) => ({
				phase: "waiting",
				state: {
					...current.state,
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
	if (!row.state.design) {
		const preparation = ports.prepareDesign?.(db, row);
		if (preparation)
			return { status: "ready", input: { kind: "design", preparation } };
	}
	const prepared = snapshot(db, row);
	return prepared
		? { status: "ready", input: { kind: "decide", snapshot: prepared } }
		: { status: "stale", reason: "goal_not_current" };
}

function createGoalAdvanceHandler(
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
		classify: (error) =>
			error instanceof Error && error.message === invalidGoalCriterionQuote
				? "fail"
				: "retry",
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
						state: current.state,
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
					advance(
						db,
						row,
						(latest) => ({ phase: "ready", state: latest.state }),
						claim.jobId,
					);
					return "stale";
				}
				const step = result.selected.step;
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
				if (accepted.status === "applied")
					submit(db, accepted.progress, claim.jobId);
				else if (accepted.status === "busy")
					advance(
						db,
						row,
						(latest) => ({
							phase: "waiting",
							dueAtMs: now() + goalPollMs,
							state: {
								...latest.state,
								next: step,
								problem: goalSlotBusy,
							},
						}),
						claim.jobId,
					);
				else if (accepted.status !== "replayed")
					problem(db, row, "goal_decision_" + accepted.status, claim.jobId);
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
		const { context, input: sources } = input.snapshot;
		const selected = await decideGoalStep(
			ports.llm(context.progressVersion),
			context,
			sources,
			signal,
		);
		if (selected.status === "invalid") throw new Error(selected.reason);
		return { kind: "decide", selected };
	}
	if (input.kind === "design")
		return { kind: "design", designed: await input.preparation.run(signal) };
	if (input.kind === "verify")
		return { kind: "verify", checks: await input.verify(signal) };
	return input;
}
