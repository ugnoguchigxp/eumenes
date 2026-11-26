import type { GoalStep, GoalStepContext } from "eumenes-agency/agenda";
import type { GoalProgress } from "eumenes-agency/agenda/runtime";
import {
	loadPlan,
	runPlan,
	type Ledger,
	type LlmPort,
	type RunResult,
} from "eumenes-thought-plan";
import document from "./goal-thought-plan.json" with { type: "json" };
import { goalDigest, type GoalCapability } from "./goal-progress-context";

/**
 * One turn of a registered goal's thinking (spec/goal-idle-deliberation-redesign-2026-11-26.md §2): review what
 * was done and decide whether to go on, check a remaining plan, and devise a method with its impact estimate.
 * The stages are the thought plan in `goal-thought-plan.json`, run by eumenes-thought-plan, which records every
 * stage's input and output in the host's ledger. Nothing is thought when the plan is on track, when a check is
 * due, or when a step was decided but could not start yet.
 */
export const goalThoughtPlan = loadPlan(document);

/** The ledger subject of a goal's turns: one per goal, so a forget removes all of them. */
export const goalSubject = (goalId: string) => `goal:${goalId}`;

/** A step of a chosen method, kept until it is carried out. */
export type PlannedStep =
	| {
			readonly kind: "act";
			readonly capabilityRef: string;
			readonly request: string;
			readonly expectedObservation: string;
			readonly criterionIds: readonly string[];
	  }
	| {
			readonly kind: "verify";
			readonly checkRef: string;
			readonly criterionId: string;
			readonly evidenceRefs: readonly string[];
	  };

/**
 * What the host keeps between turns, under `state.cycle` of the goal's progress: the rest of the chosen method,
 * a decided step still waiting for a free worker, how often the goal has stopped in a row, and what the last
 * turn saw (so a change of means or material can be told apart from nothing new).
 */
export type GoalCycle = {
	readonly remaining: readonly PlannedStep[];
	readonly pending: PlannedStep | null;
	readonly parks: number;
	/** Turns in a row that began after a failure with nothing new since the turn before. */
	readonly stalled: number;
	readonly seen: string | null;
};

const emptyCycle: GoalCycle = {
	remaining: [],
	pending: null,
	parks: 0,
	stalled: 0,
	seen: null,
};

export function cycleOf(progress: GoalProgress): GoalCycle {
	const saved = (progress.state as { cycle?: Partial<GoalCycle> }).cycle;
	return { ...emptyCycle, ...saved };
}

export function withCycle<S extends GoalProgress["state"]>(
	state: S,
	cycle: GoalCycle,
): S {
	return { ...state, cycle } as S;
}

/** A goal that stopped is looked at again after 1 hour, then 2, 4, … up to 24 hours. */
export function parkDelayMs(parks: number) {
	return Math.min(24, 2 ** Math.max(0, parks)) * 60 * 60 * 1000;
}

export type Deliberation =
	| {
			readonly kind: "step";
			readonly step: GoalStep;
			readonly remaining: readonly PlannedStep[];
			readonly planned: PlannedStep | null;
			readonly runId: string | null;
			/** The stall count this turn leaves (see `GoalCycle.stalled`). */
			readonly stalled: number;
	  }
	| {
			readonly kind: "pause";
			readonly reason: string;
			readonly runId: string | null;
	  };

type Snapshot = {
	readonly ordinaryWorkspace?: boolean;
	readonly context: GoalStepContext;
	readonly input: {
		readonly sources: readonly string[];
		readonly complete: boolean;
	};
	readonly capabilities: readonly GoalCapability[];
};

/**
 * What the turn saw of means and material; a different digest is a change worth thinking about. Evidence the
 * goal's own attempts returned is the result of trying, not something new from outside: it is left out, so a
 * method that keeps failing with fresh output still counts as failing with nothing new.
 */
export function seenDigest(context: GoalStepContext) {
	const own = new Set(
		context.attempts.flatMap(({ evidenceRefs }) => evidenceRefs),
	);
	return goalDigest([
		context.capabilities.map(({ ref }) => ref),
		context.checks.map(({ ref }) => ref),
		context.watches.map(({ ref }) => ref),
		context.evidence
			.filter(({ ref }) => !own.has(ref))
			.map(({ ref, version }) => [ref, version]),
		context.configuration?.ref ?? null,
		context.openQuestions.map(({ ref }) => ref),
	]);
}

const finished = (outcome: string) =>
	outcome !== "reserved" && outcome !== "running";
const failedOutcome = (outcome: string) =>
	outcome === "failed" || outcome === "partial" || outcome === "rejected";

/** How many of the latest finished attempts in a row failed (with this capability, if given). */
export function trailingFailures(
	attempts: GoalStepContext["attempts"],
	capabilityRef?: string,
) {
	let count = 0;
	for (const attempt of [...attempts].reverse()) {
		if (!finished(attempt.outcome)) continue;
		if (!failedOutcome(attempt.outcome)) break;
		if (capabilityRef && attempt.capabilityRef !== capabilityRef) break;
		count++;
	}
	return count;
}

const describe = (step: PlannedStep) =>
	step.kind === "act"
		? `act ${step.capabilityRef}: ${step.request}`
		: `verify ${step.checkRef} (${step.criterionId})`;

/** Evidence summaries are cut so the turn's input stays bounded; the ledger keeps the full material. */
const SUMMARY_CHARACTERS = 600;
/**
 * A stage refuses an input over 48,000 characters, and the plan stage also reads the review's output.
 * Evidence fills what the rest of the turn leaves of this bound, the goal's own text first, then newest.
 */
const INPUT_CHARACTERS = 36_000;

function fitEvidence(
	context: GoalStepContext,
	used: number,
): { ref: string; summary: string }[] {
	const items = context.evidence.map(({ ref, summary }) => ({
		ref,
		summary: summary.slice(0, SUMMARY_CHARACTERS),
	}));
	const size = (item: { ref: string; summary: string }) =>
		JSON.stringify(item).length + 1;
	const source = context.goal.sourceRef;
	const order = [
		...items.filter(({ ref }) => ref === source),
		...items.filter(({ ref }) => ref !== source).reverse(),
	];
	const kept = new Set<string>();
	let left = INPUT_CHARACTERS - used;
	for (const item of order) {
		if (size(item) > left) break;
		left -= size(item);
		kept.add(item.ref);
	}
	return items.filter(({ ref }) => kept.has(ref));
}

/** A turn after a failure with nothing new counts towards a stall; anything else ends it. */
export function stallAfter(
	context: GoalStepContext,
	cycle: GoalCycle,
	changed: boolean,
	verificationFailed = false,
) {
	return lastFailed(context, verificationFailed) && !changed
		? cycle.stalled + 1
		: 0;
}

/** The latest result failed: the last finished attempt, or the check of what it returned. */
function lastFailed(context: GoalStepContext, verificationFailed: boolean) {
	if (verificationFailed) return true;
	const last = [...context.attempts]
		.reverse()
		.find(({ outcome }) => finished(outcome));
	return !!last && failedOutcome(last.outcome);
}

/** The watch a turn may always choose: no new fact is expected soon, so look again after a while. */
export const RECHECK_WATCH = "recheck-later";
/** The latest attempts a turn reads, each text cut to this many characters. */
const HISTORY_ATTEMPTS = 12;
const HISTORY_CHARACTERS = 400;

export function planInputs(
	snapshot: Snapshot,
	cycle: GoalCycle,
	changed: boolean,
	verificationFailed = false,
) {
	const { context } = snapshot;
	const attempts = context.attempts;
	const last = [...attempts].reverse().find(({ outcome }) => finished(outcome));
	// Stopped twice in a row with nothing new, or three turns in a row went nowhere: wait or ask only.
	const mustPause =
		(cycle.parks >= 2 && !changed) ||
		stallAfter(context, cycle, changed, verificationFailed) >= 3;
	const cut = (text: string | null) =>
		text === null ? null : text.slice(0, HISTORY_CHARACTERS);
	const inputs = {
		goal: {
			desiredState: context.goal.desiredState,
			criteria: context.criteria.map(({ id, text, status }) => ({
				id,
				text,
				status,
			})),
		},
		history: {
			attempts: [
				...attempts
					.slice(-HISTORY_ATTEMPTS)
					.map(({ capabilityRef, request, outcome, observed }) => ({
						capabilityRef,
						request: cut(request) ?? "",
						outcome,
						observed: cut(observed),
					})),
				...(verificationFailed
					? [
							{
								capabilityRef: "registered-check",
								request: "返された結果を登録された検査で確かめた",
								outcome: "failed",
								observed: "検査の結果、達成条件はまだ満たされていない。",
							},
						]
					: []),
			],
			lastOutcome: verificationFailed ? "failed" : (last?.outcome ?? "none"),
			planRemaining: cycle.remaining.length > 0,
			remainingSteps: cycle.remaining.map(describe),
			changed,
			changes: changed
				? [
						...(context.configuration ? [context.configuration.summary] : []),
						"前回の1周から、能力・検査・待機条件・証拠・質問のいずれかが変わった。",
					]
				: [],
			mustPause,
		},
		capabilities: snapshot.capabilities.map(
			({ ref, description, allowedScope, effect }) => ({
				ref,
				description,
				allowedScope,
				effect,
			}),
		),
		checks: context.checks.map(({ ref, description, criterionIds }) => ({
			ref,
			description,
			criterionIds,
		})),
		watches: [
			...context.watches.map(({ ref, condition }) => ({ ref, condition })),
			{
				ref: RECHECK_WATCH,
				condition:
					"すぐに届く事実はない。時間を置いて（1時間から、続けて止まるほど長く）見直す。",
			},
		],
		evidence: [] as { ref: string; summary: string }[],
		openQuestions: context.openQuestions.map(
			({ ref, question, canResolve }) => ({
				ref,
				question,
				canResolve: canResolve === true,
			}),
		),
		editAvailability: context.editAvailability
			? {
					permittedPaths: context.editAvailability.permittedPaths,
					notBeforeMs: context.editAvailability.notBeforeMs,
					nowMs: context.editAvailability.nowMs,
					reason: context.editAvailability.reason,
				}
			: null,
	};
	inputs.evidence = fitEvidence(context, JSON.stringify(inputs).length);
	return inputs;
}

type Review = {
	decision: "continue" | "wait" | "ask";
	reason: string;
	criterionIds: string[];
	watchRef: string | null;
	missing: string | null;
	question: string | null;
	questionKind: "requirement" | "user_operation" | "execution" | null;
	resolvedQuestionRefs: string[];
	failures: { approach: string; count: number; cause: string }[];
};
type Plan = {
	candidates: { approach: string; steps: PlannedStep[] }[];
	chosen: number;
	reason: string;
};

/** The step as the goal ledger takes it, bound to this turn's snapshot. */
function toGoalStep(
	context: GoalStepContext,
	planned: PlannedStep,
	reason: string,
	review: string | null,
	resolvedQuestionRefs: readonly string[],
): GoalStep {
	const open = context.criteria
		.filter(({ status }) => status === "open")
		.map(({ id }) => id);
	const base = {
		contextId: context.contextId,
		progressVersion: context.progressVersion,
		reason,
		review,
		...(resolvedQuestionRefs.length && {
			resolvedQuestionRefs: [...resolvedQuestionRefs],
		}),
	};
	return planned.kind === "act"
		? {
				...base,
				kind: "act",
				criterionIds: planned.criterionIds.length
					? [...planned.criterionIds]
					: open,
				capabilityRef: planned.capabilityRef,
				request: planned.request,
				evidenceRefs: [],
				expectedObservation: planned.expectedObservation,
			}
		: {
				...base,
				kind: "verify",
				criterionIds: [planned.criterionId],
				checks: [
					{
						criterionId: planned.criterionId,
						checkRef: planned.checkRef,
						evidenceRefs: [...planned.evidenceRefs],
					},
				],
			};
}

/** A check is due on what the last attempt returned: verify each named criterion with its offered check. */
function dueVerification(context: GoalStepContext): PlannedStep[] | null {
	const due = context.verificationRequired;
	if (!due) return null;
	const attempt = context.attempts.find(({ ref }) => ref === due.attemptRef);
	const evidence = new Set(context.evidence.map(({ ref }) => ref));
	const steps = due.criterionIds.map((criterionId) => {
		const check = context.checks.find(({ criterionIds }) =>
			criterionIds.includes(criterionId),
		);
		return check
			? ({
					kind: "verify",
					checkRef: check.ref,
					criterionId,
					evidenceRefs: (attempt?.evidenceRefs ?? []).filter((ref) =>
						evidence.has(ref),
					),
				} as const)
			: null;
	});
	return steps.every((step) => step !== null) ? steps : null;
}

/** The goal ledger takes one verify step for all criteria a due check covers. */
function verifyAll(context: GoalStepContext, steps: PlannedStep[]): GoalStep {
	const checks = steps.flatMap((step) =>
		step.kind === "verify"
			? [
					{
						criterionId: step.criterionId,
						checkRef: step.checkRef,
						evidenceRefs: [...step.evidenceRefs],
					},
				]
			: [],
	);
	return {
		contextId: context.contextId,
		progressVersion: context.progressVersion,
		reason: "実物を返した試行の後に、登録された検査で条件を確かめる。",
		review: null,
		kind: "verify",
		criterionIds: checks.map(({ criterionId }) => criterionId),
		checks,
	};
}

/**
 * The turn. Returns the step to apply, or why the goal pauses (the caller parks it and looks again later).
 * A model failure the port marks retryable is thrown, so the queue tries again with the same input.
 */
export async function deliberateGoal(input: {
	readonly llm: LlmPort;
	readonly ledger: Ledger;
	readonly snapshot: Snapshot;
	readonly cycle: GoalCycle;
	readonly signal: AbortSignal;
	/** The last check of a returned result did not pass (`verification_incomplete`). */
	readonly verificationFailed?: boolean;
}): Promise<Deliberation> {
	const { snapshot, cycle, ledger } = input;
	const { context } = snapshot;

	// A step decided earlier is still waiting for a free worker: apply it, think nothing new.
	if (cycle.pending)
		return {
			kind: "step",
			step: toGoalStep(
				context,
				cycle.pending,
				"決めた手を、実行先が空いたので始める。",
				null,
				[],
			),
			remaining: cycle.remaining,
			planned: cycle.pending,
			runId: null,
			stalled: cycle.stalled,
		};
	const due = dueVerification(context);
	if (due)
		return {
			kind: "step",
			step: verifyAll(context, due),
			remaining: cycle.remaining,
			planned: null,
			runId: null,
			stalled: cycle.stalled,
		};

	// The first turn under this mechanism has nothing to compare with: everything it sees is new to it.
	const changed = cycle.seen === null || cycle.seen !== seenDigest(context);
	const verificationFailed = input.verificationFailed === true;
	const stalled = stallAfter(context, cycle, changed, verificationFailed);
	const inputs = planInputs(snapshot, cycle, changed, verificationFailed);
	const result: RunResult = await runPlan(goalThoughtPlan, inputs, {
		llm: portForTurn(input.llm),
		ledger,
		subjectRef: goalSubject(context.goal.id),
		llmInput: snapshot.input,
		reuse: "same_inputs",
		context: {
			progressVersion: context.progressVersion,
			contextId: context.contextId,
		},
		signal: input.signal,
	});
	// A turn that could not finish is not a stop: the queue runs it again, and after its bounded tries the
	// goal waits with the usual back-off. A preempted or cancelled call ends like an aborted job.
	if (result.status !== "completed") {
		const code = `goal_cycle_${result.errorCode ?? "failed"}`;
		throw Object.assign(new Error(code), {
			code,
			...(result.status === "cancelled" && { name: "AbortError" }),
		});
	}
	const review = result.outputs?.review as Review | null;
	const keepPlan = result.outputs?.keepPlan as boolean | null;
	const plan = result.outputs?.plan as Plan | null;
	const resolved = new Set(
		context.openQuestions
			.filter(({ canResolve }) => canResolve)
			.map(({ ref }) => ref),
	);
	const resolvedRefs = (review?.resolvedQuestionRefs ?? []).filter((ref) =>
		resolved.has(ref),
	);
	const reviewText = review?.failures.length
		? review.failures
				.map(
					({ approach, count, cause }) => `${approach}（${count}回）: ${cause}`,
				)
				.join(" / ")
		: null;

	// Waiting on nothing in particular: the goal stops and is looked at again later, with the usual back-off.
	if (review?.decision === "wait" && review.watchRef === RECHECK_WATCH)
		return { kind: "pause", reason: "goal_wait_recheck", runId: result.runId };
	if (
		snapshot.ordinaryWorkspace &&
		review?.decision === "ask" &&
		review.questionKind !== "requirement" &&
		review.questionKind !== "user_operation"
	)
		return {
			kind: "pause",
			reason: "goal_execution_wait",
			runId: result.runId,
		};
	if (review && review.decision !== "continue") {
		const base = {
			contextId: context.contextId,
			progressVersion: context.progressVersion,
			criterionIds: review.criterionIds.length
				? review.criterionIds
				: context.criteria
						.filter(({ status }) => status === "open")
						.map(({ id }) => id),
			reason: review.reason,
			review: reviewText,
			...(resolvedRefs.length && { resolvedQuestionRefs: resolvedRefs }),
		};
		return offeredOrPause(context, {
			kind: "step",
			step:
				review.decision === "wait"
					? { ...base, kind: "wait", watchRef: review.watchRef! }
					: {
							...base,
							kind: "ask",
							missing: review.missing!,
							question: review.question!,
						},
			remaining: [],
			planned: null,
			runId: result.runId,
			stalled,
		});
	}

	let steps: readonly PlannedStep[] = [];
	let reason = review?.reason ?? "";
	if (plan) {
		steps = plan.candidates[plan.chosen]!.steps;
		reason = plan.reason;
	} else if (!review || keepPlan) {
		steps = cycle.remaining;
		reason = review?.reason ?? "前の手が成功し、計画どおりに次の手へ進む。";
	}
	const [next, ...rest] = steps;
	if (!next)
		return { kind: "pause", reason: "goal_cycle_no_step", runId: result.runId };

	// The same capability failed twice in a row with nothing new since: choosing it again is not thinking.
	if (
		next.kind === "act" &&
		!changed &&
		trailingFailures(context.attempts, next.capabilityRef) >= 2
	)
		return {
			kind: "pause",
			reason: "goal_method_repeated",
			runId: result.runId,
		};
	return offeredOrPause(context, {
		kind: "step",
		step: toGoalStep(context, next, reason, reviewText, resolvedRefs),
		remaining: rest,
		planned: next,
		runId: result.runId,
		stalled,
	});
}

/**
 * A concluded turn whose step falls outside the snapshot stops the goal instead of going back to the queue:
 * the same input would reuse the same conclusion and fail the same way.
 */
function offeredOrPause(
	context: GoalStepContext,
	deliberation: Extract<Deliberation, { kind: "step" }>,
): Deliberation {
	return stepOffered(context, deliberation.step)
		? deliberation
		: {
				kind: "pause",
				reason: "goal_step_not_offered",
				runId: deliberation.runId,
			};
}

/**
 * The model port for a turn: a call the host preempted (an `AbortError` with no code while the job still runs)
 * is marked retryable, and an unusable answer keeps its own reason as the code.
 */
function portForTurn(llm: LlmPort): LlmPort {
	return {
		async complete(request, signal) {
			try {
				return await llm.complete(request, signal);
			} catch (error) {
				const failure = (error ?? {}) as {
					name?: unknown;
					code?: unknown;
					reasonCode?: unknown;
				};
				if (typeof failure.code === "string") throw error;
				if (failure.name === "AbortError" && !signal.aborted)
					throw Object.assign(new Error("llm_preempted"), {
						code: "llm_preempted",
						retryable: true,
					});
				if (typeof failure.reasonCode === "string")
					throw Object.assign(new Error(failure.reasonCode), {
						code: `llm_${failure.reasonCode}`.replace(/[^a-z0-9_]/g, "_"),
						retryable: false,
					});
				throw error;
			}
		},
	};
}

/**
 * The last gate before the goal ledger: the step must answer this snapshot, and every reference of it must be one the turn was shown (the
 * criteria, capabilities, watches, checks, evidence and resolvable questions of the snapshot), and a check due
 * on a returned result must be answered by verifying its criteria. A step that fails it is not applied.
 */
export function stepOffered(context: GoalStepContext, step: GoalStep): boolean {
	if (
		step.contextId !== context.contextId ||
		step.progressVersion !== context.progressVersion
	)
		return false;
	const targets = new Set(step.criterionIds);
	const resolved = step.resolvedQuestionRefs ?? [];
	if (
		new Set(resolved).size !== resolved.length ||
		resolved.some(
			(id) =>
				!context.openQuestions.some(
					(question) =>
						question.ref === id &&
						question.canResolve &&
						question.configurationRef === context.configuration?.ref,
				),
		)
	)
		return false;
	if (
		context.verificationRequired &&
		(step.kind !== "verify" ||
			!context.verificationRequired.criterionIds.every((id) => targets.has(id)))
	)
		return false;
	if (
		!step.criterionIds.every((id) => context.criteria.some((c) => c.id === id))
	)
		return false;
	const shown = (refs: readonly string[]) =>
		refs.every((id) => context.evidence.some((item) => item.ref === id));
	switch (step.kind) {
		case "act":
			return (
				context.capabilities.some(({ ref }) => ref === step.capabilityRef) &&
				shown(step.evidenceRefs)
			);
		case "wait":
			return context.watches.some(({ ref }) => ref === step.watchRef);
		case "ask":
			return true;
		case "verify":
			return (
				step.checks.every(
					({ criterionId, checkRef, evidenceRefs }) =>
						targets.has(criterionId) &&
						context.checks.some(
							(check) =>
								check.ref === checkRef &&
								check.criterionIds.includes(criterionId),
						) &&
						shown(evidenceRefs),
				) &&
				step.criterionIds.every((id) =>
					step.checks.some((check) => check.criterionId === id),
				)
			);
	}
}
