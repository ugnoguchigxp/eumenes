import type { GoalStep, GoalStepContext } from "eumenes-agency/agenda";
import type { GoalProgress } from "eumenes-agency/agenda/runtime";
import {
	continuePlan,
	loadPlan,
	loadRunState,
	runPlan,
	type Ledger,
	type LlmPort,
	type LlmRequest,
	type RunResult,
} from "eumenes-thought-plan";
import document from "eumenes-thought-plan/plans/goal-pursuit.json" with { type: "json" };
import type { GoalCapability } from "./goal-progress-context";
import {
	ownerNotice,
	THOUGHT_LIMIT,
	type ThoughtBudget,
} from "./goal-thought-budget";

/**
 * A registered goal's thinking (spec/goal-thought-session-2026-11-26.md). One autonomous run of a goal is one
 * run of the package's `goal-pursuit` plan, in one model session. Its first round looks back at what was done,
 * judges whether the goal is met or can go on, and devises a procedure with its impact; the host then carries
 * the procedure out step by step without thinking. Only a step whose result went wrong, or a procedure that
 * ended short of the goal, opens the next round of the same session, which reflects and re-plans.
 */
export const goalThoughtPlan = loadPlan(document);

/** The ledger subject of a goal's thinking: one per goal, so a forget removes all of it. */
export const goalSubject = (goalId: string) => `goal:${goalId}`;

/** A step of the procedure, kept until it is carried out. */
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

/** What the goal did last, so the next turn knows whose result it reads. */
type Current = {
	readonly step: string;
	readonly kind: "act" | "verify" | "wait";
};

/**
 * What the host keeps between turns, under `state.cycle` of the goal's progress: the session this autonomous run
 * thinks in, the step carried out last and the rest of the procedure, the steps that went as expected since the
 * last round, a decided step still waiting for a free worker, and how often the goal stopped in a row.
 */
export type GoalCycle = {
	/** The thought-plan run (one session) of this autonomous run; null until its first round. */
	readonly runId: string | null;
	readonly current: Current | null;
	readonly remaining: readonly PlannedStep[];
	readonly since: readonly { step: string; observed: string | null }[];
	readonly pending: PlannedStep | null;
	readonly parks: number;
	/** The latest finished attempt when the goal last took a step or read a result: older ones are not news. */
	readonly consumed: string | null;
} & ThoughtBudget;

const emptyCycle: GoalCycle = {
	runId: null,
	current: null,
	remaining: [],
	since: [],
	pending: null,
	parks: 0,
	consumed: null,
	thoughts: 0,
	answers: [],
	reason: null,
};

export function cycleOf(progress: GoalProgress): GoalCycle {
	const saved = (progress.state as { cycle?: Partial<GoalCycle> }).cycle;
	const cycle = { ...emptyCycle, ...saved };
	// A cycle saved before answers were kept by question counts nothing: it starts as if nothing were answered.
	return Array.isArray(cycle.answers) ? cycle : { ...cycle, answers: [] };
}

/** The questions of the goal the owner has answered. */
export const answeredRefs = (progress: GoalProgress) =>
	progress.state.questions
		.filter(({ answeredBy }) => answeredBy)
		.map(({ ref }) => ref);

/** An answer the run has not seen begins a new autonomous run: a new session and its own bound of thinking. */
export function ownRun(
	cycle: GoalCycle,
	answered: readonly string[],
): GoalCycle {
	return answered.some((ref) => !cycle.answers.includes(ref))
		? { ...emptyCycle, answers: [...answered] }
		: cycle;
}

/** What a turn that did not take its step still leaves: the session, the count of thinking, the result read. */
export const budgetOf = (cycle: Partial<GoalCycle>): Partial<GoalCycle> => ({
	...(cycle.runId !== undefined && { runId: cycle.runId }),
	...(cycle.thoughts !== undefined && { thoughts: cycle.thoughts }),
	...(cycle.answers !== undefined && { answers: cycle.answers }),
	...(cycle.reason !== undefined && { reason: cycle.reason }),
	...(cycle.consumed !== undefined && { consumed: cycle.consumed }),
	remaining: [],
	since: [],
});

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

/** What a turn concludes, and the cycle it leaves for the caller to store. */
export type Deliberation = (
	| {
			readonly kind: "step";
			readonly step: GoalStep;
			/** The procedure step this is, kept when no worker is free yet. */
			readonly planned: PlannedStep | null;
	  }
	| { readonly kind: "pause"; readonly reason: string }
) & { readonly cycle?: Partial<GoalCycle> };

type Snapshot = {
	readonly ordinaryWorkspace?: boolean;
	readonly context: GoalStepContext;
	readonly input: {
		readonly sources: readonly string[];
		readonly complete: boolean;
	};
	readonly capabilities: readonly GoalCapability[];
};

const describe = (step: PlannedStep) =>
	step.kind === "act"
		? `act ${step.capabilityRef}: ${step.request}`
		: `verify ${step.checkRef} (${step.criterionId})`;
const currentOf = (step: PlannedStep): Current => ({
	step: describe(step),
	kind: step.kind,
});

/** Evidence summaries are cut so the turn's input stays bounded; the ledger keeps the full material. */
const SUMMARY_CHARACTERS = 600;
/**
 * A stage refuses an input over 48,000 characters. Evidence fills what the rest of the first stage's input
 * leaves of this bound, the goal's own text first, then newest.
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

/** The wait a turn may always choose: no new fact is expected soon, so look again after a while. */
export const RECHECK_WATCH = "recheck-later";
/** The latest attempts the first round reads, each text cut to this many characters. */
const HISTORY_ATTEMPTS = 12;
const HISTORY_CHARACTERS = 400;
const cut = (text: string | null) =>
	text === null ? null : text.slice(0, HISTORY_CHARACTERS);

/** The first round's inputs: the goal, what was done so far, the material, and the means it may use. */
export function planInputs(snapshot: Snapshot) {
	const { context } = snapshot;
	const editFrom = context.editAvailability?.notBeforeMs ?? null;
	const inputs = {
		goal: {
			desiredState: context.goal.desiredState,
			criteria: context.criteria.map(({ id, text, status }) => ({
				id,
				text,
				status,
			})),
		},
		history: context.attempts
			.slice(-HISTORY_ATTEMPTS)
			.map(({ capabilityRef, request, outcome, observed }) => ({
				capabilityRef,
				request: cut(request) ?? "",
				outcome,
				observed: cut(observed),
			})),
		evidence: [] as { ref: string; summary: string }[],
		capabilities: snapshot.capabilities.map(({ ref, description, effect }) => ({
			ref,
			// A write that may not start yet says so where the means are described.
			description:
				effect === "write" &&
				editFrom !== null &&
				editFrom > (context.editAvailability?.nowMs ?? 0)
					? `${description}（${new Date(editFrom).toISOString()} より前には使えない）`
					: description,
			effect,
		})),
		checks: context.checks.map(({ ref, description, criterionIds }) => ({
			ref,
			description,
			criterionIds,
		})),
		waits: [
			...context.watches.map(({ ref, condition }) => ({ ref, condition })),
			{
				ref: RECHECK_WATCH,
				condition:
					"すぐに届く事実はない。時間を置いて（1時間から、続けて止まるほど長く）見直す。",
			},
		],
		openQuestions: context.openQuestions.map(({ ref, question }) => ({
			ref,
			question,
		})),
	};
	inputs.evidence = fitEvidence(context, JSON.stringify(inputs).length);
	return inputs;
}

const latestFinished = (context: GoalStepContext) =>
	[...context.attempts]
		.reverse()
		.find(({ outcome }) => outcome !== "reserved" && outcome !== "running");

/** What the step carried out last returned, as the next round reads it; null when there is nothing yet. */
function lastResult(
	context: GoalStepContext,
	cycle: GoalCycle,
	verificationFailed: boolean,
): {
	outcome: "succeeded" | "partial" | "failed" | "rejected" | "finished";
	observed: string | null;
	evidence: { ref: string; summary: string }[];
} | null {
	if (!cycle.current) return null;
	const summaries = (refs: readonly string[]) =>
		context.evidence
			.filter(({ ref }) => refs.includes(ref))
			.map(({ ref, summary }) => ({
				ref,
				summary: summary.slice(0, SUMMARY_CHARACTERS),
			}));
	if (verificationFailed)
		return {
			outcome: "failed",
			observed: "検査の結果、達成条件はまだ満たされていない。",
			evidence: summaries(context.evidence.slice(-2).map(({ ref }) => ref)),
		};
	if (cycle.current.kind === "wait")
		return {
			outcome: "finished",
			observed: "待っていた条件が満たされたか、見直す時刻になった。",
			evidence: [],
		};
	const last = latestFinished(context);
	// No newer attempt than the one read before: the step taken last never ran.
	if (!last || last.ref === cycle.consumed)
		return {
			outcome: "rejected",
			observed:
				"決めた手を実行できなかった（受け付けられなかったか、提示された範囲から外れた）。",
			evidence: [],
		};
	return {
		outcome:
			last.outcome === "succeeded" ||
			last.outcome === "partial" ||
			last.outcome === "rejected"
				? last.outcome
				: "failed",
		observed: cut(last.observed),
		evidence: summaries(last.evidenceRefs),
	};
}

type Judgment = {
	decision: "continue" | "wait" | "ask";
	reason: string;
	waitRef: string | null;
	question: string | null;
	missing: string | null;
};
type Reflection = {
	decision: "replan" | "wait" | "ask";
	change: string;
	waitRef: string | null;
	question: string | null;
	missing: string | null;
};
type Procedure = {
	candidates: { approach: string; steps: PlannedStep[] }[];
	chosen: number;
	reason: string;
};

/** The step as the goal ledger takes it, bound to this turn's snapshot. */
function toGoalStep(
	context: GoalStepContext,
	planned: PlannedStep,
	reason: string,
): GoalStep {
	const open = context.criteria
		.filter(({ status }) => status === "open")
		.map(({ id }) => id);
	const base = {
		contextId: context.contextId,
		progressVersion: context.progressVersion,
		reason,
		review: null,
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
 * The turn. Applies a decided step, a due check or the procedure's next step without the model; otherwise thinks
 * one round of the autonomous run's session (the first round, or the next after a result that went wrong) and
 * returns what it concluded. Past the bound of thinking it asks the owner once, without the model.
 */
export async function deliberateGoal(input: {
	readonly llm: LlmPort;
	readonly ledger: Ledger;
	readonly snapshot: Snapshot;
	readonly cycle: GoalCycle;
	readonly signal: AbortSignal;
	/** The last check of a returned result did not pass (`verification_incomplete`). */
	readonly verificationFailed?: boolean;
	/** The questions of this goal the owner has answered so far. */
	readonly answered?: readonly string[];
}): Promise<Deliberation> {
	const { snapshot, ledger } = input;
	const { context } = snapshot;
	let cycle = ownRun(input.cycle, input.answered ?? []);
	const open = context.criteria
		.filter(({ status }) => status === "open")
		.map(({ id }) => id);
	const consumed = latestFinished(context)?.ref ?? null;
	// A step the host takes without thinking must still be one this snapshot offers.
	const take = (
		planned: PlannedStep,
		reason: string,
		patch: Partial<GoalCycle>,
	): Deliberation | null => {
		const step = toGoalStep(context, planned, reason);
		return stepOffered(context, step)
			? {
					kind: "step",
					step,
					planned,
					cycle: { ...cycle, ...patch, consumed, current: currentOf(planned) },
				}
			: null;
	};

	// A step decided earlier is still waiting for a free worker: apply it, think nothing new.
	if (cycle.pending) {
		const resumed = take(
			cycle.pending,
			"決めた手を、実行先が空いたので始める。",
			{ pending: null },
		);
		if (resumed) return resumed;
		cycle = { ...cycle, pending: null, remaining: [] };
	}
	const due = dueVerification(context);
	if (due) {
		const step = verifyAll(context, due);
		if (stepOffered(context, step))
			return {
				kind: "step",
				step,
				planned: null,
				cycle: {
					...cycle,
					consumed,
					current: { step: due.map(describe).join(" / "), kind: "verify" },
				},
			};
	}

	// The procedure is on track: its next step, without thinking. A next step no longer offered goes back to
	// the session as a step that could not run.
	let result = lastResult(context, cycle, input.verificationFailed === true);
	const [following, ...later] = cycle.remaining;
	if (cycle.runId && result?.outcome === "succeeded" && following) {
		const since = [
			...cycle.since,
			{ step: cycle.current?.step ?? "", observed: result.observed },
		];
		const next = take(following, "手順どおりに次の手へ進む。", {
			remaining: later,
			since,
		});
		if (next) return next;
		cycle = { ...cycle, since, remaining: [], current: currentOf(following) };
		result = {
			outcome: "rejected",
			observed:
				"手順の次の手が、提示された能力・検査の範囲から外れて実行できなかった。",
			evidence: [],
		};
	}
	const notice = (): Deliberation => {
		const step = ownerNotice(context, cycle);
		return stepOffered(context, step)
			? {
					kind: "step",
					step,
					planned: null,
					cycle: {
						...cycle,
						consumed,
						current: null,
						remaining: [],
						since: [],
					},
				}
			: {
					kind: "pause",
					reason: "goal_step_not_offered",
					cycle: budgetOf(cycle),
				};
	};
	if (cycle.thoughts >= THOUGHT_LIMIT) return notice();

	// Think: the next round of this run's session with what the last step returned, or a new run's first round.
	const state =
		cycle.runId && result
			? loadRunState(goalThoughtPlan, ledger, cycle.runId)
			: null;
	const options = {
		llm: portForTurn(input.llm),
		ledger,
		subjectRef: goalSubject(context.goal.id),
		llmInput: snapshot.input,
		context: {
			progressVersion: context.progressVersion,
			contextId: context.contextId,
		},
		signal: input.signal,
	};
	const run: RunResult =
		state && result
			? await continuePlan(
					goalThoughtPlan,
					state,
					{
						since: cycle.since,
						result: {
							step: cycle.current?.step ?? "",
							...result,
							// The procedure ran out with the goal still open: that went short of what it meant to do.
							outcome:
								result.outcome === "succeeded" ? "finished" : result.outcome,
						},
					},
					options,
				)
			: await runPlan(goalThoughtPlan, planInputs(snapshot), options);
	if (run.errorCode === "rounds_exhausted") return notice();
	// A round that could not finish is not a stop: it counts as thought, and the goal waits with the usual
	// back-off before the next try. A preempted or cancelled call ends like an aborted job.
	if (run.status !== "completed") {
		const code = `goal_cycle_${run.errorCode ?? "failed"}`;
		throw Object.assign(new Error(code), {
			code,
			...(run.status === "cancelled" && { name: "AbortError" }),
		});
	}
	const outputs = run.outputs as {
		judgment: Judgment | null;
		reflection: Reflection | null;
		procedure: Procedure | null;
	};
	const first = run.round === 1;
	const said = first ? outputs.judgment : outputs.reflection;
	const reason =
		outputs.procedure?.reason ??
		(first ? outputs.judgment?.reason : outputs.reflection?.change) ??
		cycle.reason;
	const spent: Partial<GoalCycle> = {
		runId: run.runId,
		thoughts: cycle.thoughts + 1,
		reason,
		consumed,
		since: [],
		remaining: [],
	};
	const base = {
		contextId: context.contextId,
		progressVersion: context.progressVersion,
		criterionIds: open,
		reason: reason ?? "",
		review: null,
	};
	if (said?.decision === "wait") {
		const current: Current = { step: `wait ${said.waitRef}`, kind: "wait" };
		// Waiting on nothing in particular: the goal stops and is looked at again later, with the usual back-off.
		if (said.waitRef === RECHECK_WATCH)
			return {
				kind: "pause",
				reason: "goal_wait_recheck",
				cycle: { ...cycle, ...spent, current },
			};
		return offeredOrPause(context, {
			kind: "step",
			step: { ...base, kind: "wait", watchRef: said.waitRef! },
			planned: null,
			cycle: { ...cycle, ...spent, current },
		});
	}
	if (said?.decision === "ask")
		return offeredOrPause(context, {
			kind: "step",
			step: {
				...base,
				kind: "ask",
				missing: said.missing!,
				question: said.question!,
			},
			planned: null,
			cycle: { ...cycle, ...spent, current: null },
		});
	const procedure = outputs.procedure;
	const [next, ...rest] = procedure?.candidates[procedure.chosen]?.steps ?? [];
	if (!next)
		return {
			kind: "pause",
			reason: "goal_cycle_no_step",
			cycle: budgetOf({ ...cycle, ...spent }),
		};
	return offeredOrPause(context, {
		kind: "step",
		step: toGoalStep(context, next, reason ?? ""),
		planned: next,
		cycle: { ...cycle, ...spent, remaining: rest, current: currentOf(next) },
	});
}

/**
 * A concluded turn whose step falls outside the snapshot stops the goal instead of going back to the queue:
 * the thought already counted, and the next turn thinks again from the result.
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
				...(deliberation.cycle && { cycle: budgetOf(deliberation.cycle) }),
			};
}

/**
 * How a session reaches the Eumenes model connection, which sends a system message and the messages after it:
 * the system is the same for every stage, and each stage's own system context opens its turn, so the leading
 * messages stay the same from stage to stage and their cached prefix carries over.
 */
export const SESSION_SYSTEM =
	"思考プランの段に、一段ずつ答える。各段の指示はその段の依頼の先頭にあり、それまでのやり取りはこのセッションの前の段である。出力は指定の形式だけにする。";
const turnText = (system: string, prompt: string) =>
	`# この段の指示\n${system}\n\n# 入力\n${prompt}`;
export function sessionMessages(request: LlmRequest<unknown>) {
	const turns = request.session?.turns ?? [];
	return [
		...turns.flatMap((turn) => [
			{ role: "user" as const, content: turnText(turn.system, turn.prompt) },
			{ role: "assistant" as const, content: turn.output },
		]),
		{
			role: "user" as const,
			content: turnText(request.system, request.prompt),
		},
	];
}

/**
 * The model port for a turn: the session as messages; a call the host preempted (an `AbortError` with no code while the job still runs)
 * is marked retryable, and an unusable answer keeps its own reason as the code.
 */
function portForTurn(llm: LlmPort): LlmPort {
	return {
		async complete(request, signal) {
			try {
				// The session goes as messages under one system; the host port sends them as they are.
				return await llm.complete(
					{
						...request,
						system: SESSION_SYSTEM,
						messages: sessionMessages(request),
					} as typeof request,
					signal,
				);
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
