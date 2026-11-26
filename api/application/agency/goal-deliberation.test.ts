import { expect, test } from "bun:test";
import type { GoalStepContext } from "eumenes-agency/agenda";
import {
	createLedger,
	openLedgerStore,
	type LlmPort,
	type LlmRequest,
} from "eumenes-thought-plan";
import {
	cycleOf,
	deliberateGoal,
	goalThoughtPlan,
	parkDelayMs,
	seenDigest,
	stepOffered,
	type GoalCycle,
} from "./goal-deliberation";
import type { GoalCapability } from "./goal-progress-context";
import { createIdleWatch, GOAL_IDLE_AFTER_MS } from "./registered-goals";

const goalText =
	"Live2Dの背景を設定でさまざまな色に変更できるようにすること。達成条件は、設定から背景色を変更できること。";
const checkRef = "goal-check:avatar-background-behavior";
const supervision = "goal-capability:supervision-read";

/** The stalled Live2D goal of 2026-11-25/26, as the turn sees it. */
function context(overrides: Partial<GoalStepContext> = {}): GoalStepContext {
	const failed = (n: number) => ({
		ref: `attempt-${n}`,
		criterionIds: ["root"],
		capabilityRef: supervision,
		request: "背景色の関連テストを実行してください。",
		expectedObservation: "試験の結果",
		outcome: "failed" as const,
		observed: "担当の判断を確定できず、作業を終了しました。",
		evidenceRefs: n === 1 ? ["read:1"] : [],
	});
	return {
		version: 1,
		contextId: "ctx-1",
		goal: {
			id: "goal-1",
			revision: 1,
			desiredState: goalText,
			sourceRef: "words",
		},
		progressVersion: 7,
		criteria: [
			{ id: "root", text: goalText, status: "open", evidenceRefs: [] },
		],
		evidence: [
			{
				ref: "read:1",
				version: "1",
				summary: "background.ts に色の選択と保存がある",
			},
		],
		attempts: [failed(1), failed(2), failed(3)],
		capabilities: [
			{
				ref: supervision,
				description: "開発監督に作業先のファイルを読ませる",
				allowedScope: "eumenes-avatar",
			},
		],
		watches: [
			{
				ref: "configuration-or-input",
				condition: "構成が変わる",
				dueAtMs: null,
			},
		],
		checks: [
			{
				ref: checkRef,
				description: "背景色の選択・保存・復元を試験で確かめる",
				criterionIds: ["root"],
			},
		],
		openQuestions: [],
		reviewRequired: false,
		...overrides,
	};
}
const capabilities = (ctx: GoalStepContext): GoalCapability[] =>
	ctx.capabilities.map((capability) => ({
		...capability,
		owner: "development-supervision",
		bindingRevisionId: "bind:1",
		permitId: "permit:1",
		permitRevision: 1,
		operationRef: "read",
		effect: "read" as const,
	}));
const snapshot = (ctx: GoalStepContext) => ({
	context: ctx,
	input: { sources: ["words"], complete: true },
	capabilities: capabilities(ctx),
});
const cycle = (partial: Partial<GoalCycle> = {}): GoalCycle => ({
	remaining: [],
	pending: null,
	parks: 0,
	stalled: 0,
	seen: null,
	...partial,
});

const review = (decision: string, extra: Record<string, unknown> = {}) => ({
	done: ["関連テストの実行を監督に頼んだ"],
	learned: ["色の選択と保存の実装がある"],
	failures: [
		{ approach: "監督に試験を頼む", count: 3, cause: "判断が確定しない" },
	],
	changedSinceLast: [],
	decision,
	reason: "登録検査をまだ試していない",
	criterionIds: ["root"],
	watchRef: null,
	missing: null,
	question: null,
	questionKind: null,
	resolvedQuestionRefs: [],
	...extra,
});
const verifyPlan = (ref = checkRef) => ({
	candidates: [
		{
			approach: "登録検査で既存の実装を確かめる",
			steps: [
				{
					kind: "verify",
					checkRef: ref,
					criterionId: "root",
					evidenceRefs: ["read:1"],
				},
			],
			impact: {
				changes: "none",
				reversible: true,
				inferenceCalls: 0,
				minutes: 2,
				ifFails: "理由が残る",
			},
		},
	],
	chosen: 0,
	reason: "変更なしで条件を試験で確かめられる",
});

/** A model that answers each stage of the goal plan from `byStage`, counting the calls. */
function model(byStage: Record<string, unknown>) {
	const stageOf = new Map(goalThoughtPlan.stages.map((s) => [s.system, s.id]));
	const asked: string[] = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>) {
			const id = stageOf.get(request.system)!;
			asked.push(id);
			return {
				value: byStage[id] as T,
				model: "fixture",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	return { llm, asked };
}
const turn = (
	llm: LlmPort,
	ctx: GoalStepContext,
	state: GoalCycle,
	ledger = createLedger(null, "off"),
) =>
	deliberateGoal({
		llm,
		ledger,
		snapshot: snapshot(ctx),
		cycle: state,
		signal: new AbortController().signal,
	});

test("the stalled goal reviews its repeated failures and chooses the registered check it never tried", async () => {
	const ctx = context();
	const { llm, asked } = model({
		review: review("continue"),
		plan: verifyPlan(),
	});
	const result = await turn(llm, ctx, cycle());
	expect(asked).toEqual(["review", "plan"]);
	expect(result).toMatchObject({
		kind: "step",
		step: {
			kind: "verify",
			contextId: "ctx-1",
			progressVersion: 7,
			checks: [{ checkRef, criterionId: "root", evidenceRefs: ["read:1"] }],
		},
	});
	if (result.kind === "step") expect(stepOffered(ctx, result.step)).toBe(true);
});

test("on track, decided, or due for a check: no model call", async () => {
	const ctx = context({
		attempts: [
			{
				...context().attempts[0]!,
				outcome: "succeeded",
				evidenceRefs: ["read:1"],
			},
		],
	});
	const next = {
		kind: "verify" as const,
		checkRef,
		criterionId: "root",
		evidenceRefs: ["read:1"],
	};
	const silent = model({});
	const onTrack = await turn(
		silent.llm,
		ctx,
		cycle({ remaining: [next], seen: seenDigest(ctx) }),
	);
	expect(onTrack).toMatchObject({
		kind: "step",
		step: { kind: "verify" },
		remaining: [],
	});

	const pending = await turn(silent.llm, context(), cycle({ pending: next }));
	expect(pending).toMatchObject({ kind: "step", step: { kind: "verify" } });

	const due = await turn(
		silent.llm,
		context({
			verificationRequired: { attemptRef: "attempt-1", criterionIds: ["root"] },
		}),
		cycle(),
	);
	expect(due).toMatchObject({
		kind: "step",
		step: { kind: "verify", checks: [{ checkRef, evidenceRefs: ["read:1"] }] },
	});
	expect(silent.asked).toEqual([]);
});

test("the capability that failed twice in a row with nothing new is not chosen again", async () => {
	const ctx = context();
	const actPlan = {
		...verifyPlan(),
		candidates: [
			{
				...verifyPlan().candidates[0]!,
				steps: [
					{
						kind: "act",
						capabilityRef: supervision,
						request: "もう一度試験を実行してください。",
						expectedObservation: "試験の結果",
						criterionIds: ["root"],
					},
				],
			},
		],
	};
	const { llm } = model({ review: review("continue"), plan: actPlan });
	const seen = seenDigest(ctx);
	expect(await turn(llm, ctx, cycle({ seen }))).toMatchObject({
		kind: "pause",
		reason: "goal_method_repeated",
	});
});

test("a goal that kept stopping with nothing new may only wait or ask; a change lifts it", async () => {
	const ctx = context();
	const seen = seenDigest(ctx);
	const keepsGoing = model({ review: review("continue"), plan: verifyPlan() });
	await expect(
		turn(keepsGoing.llm, ctx, cycle({ parks: 2, seen })),
	).rejects.toMatchObject({ code: "goal_cycle_stage_output_inconsistent" });
	expect(
		await turn(keepsGoing.llm, ctx, cycle({ parks: 2, seen: "older" })),
	).toMatchObject({ kind: "step", step: { kind: "verify" } });
	const asks = model({
		review: review("ask", {
			missing: "背景色を確かめる手段",
			question: "背景色の設定を確かめる方法を指定できますか？",
		}),
	});
	expect(await turn(asks.llm, ctx, cycle({ parks: 2, seen }))).toMatchObject({
		kind: "step",
		step: {
			kind: "ask",
			question: "背景色の設定を確かめる方法を指定できますか？",
		},
	});
	const waitsOnNothing = model({
		review: review("wait", { watchRef: "no-such-watch" }),
	});
	await expect(turn(waitsOnNothing.llm, ctx, cycle())).rejects.toMatchObject({
		code: "goal_cycle_stage_output_inconsistent",
	});
	const waitsAWhile = model({
		review: review("wait", { watchRef: "recheck-later" }),
	});
	expect(
		await turn(waitsAWhile.llm, ctx, cycle({ parks: 2, seen })),
	).toMatchObject({
		kind: "pause",
		reason: "goal_wait_recheck",
	});
});

test("a call the host preempted, or an unusable answer, is tried again rather than stopping the goal", async () => {
	const preempted: LlmPort = {
		async complete() {
			throw Object.assign(new Error("preempted"), { name: "AbortError" });
		},
	};
	await expect(turn(preempted, context(), cycle())).rejects.toMatchObject({
		code: "goal_cycle_llm_preempted",
	});
	const garbled: LlmPort = {
		async complete() {
			throw Object.assign(new Error("schema"), { reasonCode: "schema" });
		},
	};
	await expect(turn(garbled, context(), cycle())).rejects.toMatchObject({
		code: "goal_cycle_llm_schema",
	});
});

test("evidence the goal's own attempts returned is not a change; outside evidence is", () => {
	const ctx = context();
	const own = context({
		evidence: [
			...ctx.evidence,
			{ ref: "read:1", version: "2", summary: "再読" },
		],
	});
	expect(seenDigest(own)).toBe(
		seenDigest(context({ evidence: [{ ...ctx.evidence[0]!, version: "2" }] })),
	);
	const outside = context({
		evidence: [
			...ctx.evidence,
			{ ref: "note:1", version: "1", summary: "調査メモ" },
		],
	});
	expect(seenDigest(outside)).not.toBe(seenDigest(ctx));
});

test("a failed check of a returned result counts as a failure of the turn before", async () => {
	const ctx = context({
		attempts: [{ ...context().attempts[0]!, outcome: "succeeded" }],
	});
	const { planInputs } = await import("./goal-deliberation");
	const inputs = planInputs(
		snapshot(ctx),
		cycle({ seen: seenDigest(ctx), stalled: 2 }),
		false,
		true,
	);
	expect(inputs.history.lastOutcome).toBe("failed");
	expect(inputs.history.mustPause).toBe(true);
	expect(inputs.history.attempts.at(-1)).toMatchObject({ outcome: "failed" });
});

test("a goal with much evidence still thinks: the goal's words and the newest evidence fit the turn", async () => {
	const evidence = [
		{ ref: "words", version: "1", summary: goalText },
		...Array.from({ length: 80 }, (_, n) => ({
			ref: `read:${80 - n}`,
			version: "1",
			summary: `読取結果${80 - n}：${"背景色".repeat(300)}`,
		})),
	];
	const ctx = context({ evidence });
	const { planInputs } = await import("./goal-deliberation");
	const inputs = planInputs(snapshot(ctx), cycle(), true);
	const refs = inputs.evidence.map(({ ref }) => ref);
	expect(JSON.stringify(inputs).length).toBeLessThanOrEqual(36_000);
	expect(refs[0]).toBe("words");
	expect(refs).toContain("read:1");
	expect(refs).not.toContain("read:80");
	const { llm, asked } = model({
		review: review("continue"),
		plan: verifyPlan(),
	});
	const result = await turn(llm, ctx, cycle());
	expect(asked).toEqual(["review", "plan"]);
	expect(result).toMatchObject({ kind: "step", step: { kind: "verify" } });
});

test("the same turn input reuses the last conclusion without a model call", async () => {
	const ledger = createLedger(openLedgerStore(":memory:"));
	const ctx = context();
	const { llm, asked } = model({
		review: review("continue"),
		plan: verifyPlan(),
	});
	await turn(llm, ctx, cycle(), ledger);
	const second = await turn(llm, ctx, cycle(), ledger);
	expect(asked).toEqual(["review", "plan"]);
	expect(second).toMatchObject({ kind: "step", step: { kind: "verify" } });
	expect(
		ledger
			.listRuns({ subjectRef: "goal:goal-1" })
			.map(({ reusedRunId }) => !!reusedRunId),
	).toEqual([true, false]);
});

test("a step outside what the turn was shown is never applied", () => {
	const ctx = context();
	const base = {
		contextId: ctx.contextId,
		progressVersion: ctx.progressVersion,
		criterionIds: ["root"],
		reason: "r",
		review: null,
	};
	expect(
		stepOffered(ctx, {
			...base,
			kind: "act",
			capabilityRef: "goal-capability:unknown",
			request: "x",
			evidenceRefs: [],
			expectedObservation: "y",
		}),
	).toBe(false);
	expect(
		stepOffered(ctx, {
			...base,
			kind: "wait",
			watchRef: "configuration-or-input",
		}),
	).toBe(true);
	expect(
		stepOffered(ctx, {
			...base,
			contextId: "old",
			kind: "wait",
			watchRef: "configuration-or-input",
		}),
	).toBe(false);
});

test("a stopped goal is looked at again after 1, 2, 4 … hours, at most 24", () => {
	expect(
		[0, 1, 2, 5, 9].map((parks) => parkDelayMs(parks) / 3_600_000),
	).toEqual([1, 2, 4, 24, 24]);
	expect(cycleOf({ state: {} } as never)).toEqual(cycle());
});

test("a goal thinks only once the foreground has been quiet for two minutes", () => {
	let clock = 1_000_000;
	let busy = false;
	const listeners: (() => void)[] = [];
	const watch = createIdleWatch(
		{
			foregroundBusy: () => busy,
			onActivity: (listener) => {
				listeners.push(listener);
				return () => {};
			},
		},
		() => clock,
	);
	expect(watch.until()).toBeNull();
	busy = true;
	listeners.forEach((listener) => listener());
	expect(watch.until()).toBe(clock + GOAL_IDLE_AFTER_MS);
	clock += 5_000;
	busy = false;
	listeners.forEach((listener) => listener());
	const ended = clock;
	clock += 60_000;
	expect(watch.until()).toBe(ended + GOAL_IDLE_AFTER_MS);
	clock = ended + GOAL_IDLE_AFTER_MS;
	expect(watch.until()).toBeNull();
	// Background requests (a goal's own thinking included) start and end without moving the clock.
	clock += 10_000;
	listeners.forEach((listener) => listener());
	clock += 30_000;
	listeners.forEach((listener) => listener());
	expect(watch.until()).toBeNull();
	expect(createIdleWatch(undefined).until()).toBeNull();
});

test("three turns in a row that went nowhere may only wait or ask", async () => {
	const ctx = context();
	const seen = seenDigest(ctx);
	const keepsGoing = model({ review: review("continue"), plan: verifyPlan() });
	expect(
		await turn(keepsGoing.llm, ctx, cycle({ stalled: 1, seen })),
	).toMatchObject({ kind: "step", stalled: 2 });
	await expect(
		turn(keepsGoing.llm, ctx, cycle({ stalled: 2, seen })),
	).rejects.toMatchObject({ code: "goal_cycle_stage_output_inconsistent" });
});

test("a goal does not think while the foreground is busy; it waits until idling can begin", async () => {
	const { fixture } = await import("./goal-progress.fixture");
	let idleAt: number | null = 10_000;
	const f = fixture(
		() => ({
			kind: "ask",
			missing: "期待値との差",
			question: "確認できますか？",
		}),
		{ idleUntil: () => idleAt },
	);
	try {
		const key = await f.register();
		await f.queue.tick();
		await f.queue.tick();
		expect(f.decisions()).toBe(0);
		expect(f.state(key).dueAtMs).toBe(10_000);
		idleAt = null;
		f.advance(10_000);
		await f.until(() => f.decisions() === 1);
	} finally {
		await f.close();
	}
});

test("an ordinary workspace treats an execution question as waiting", async () => {
	const { llm } = model({
		review: review("ask", {
			questionKind: "execution",
			missing: "tool access",
			question: "Which checkout?",
		}),
	});
	const result = await deliberateGoal({
		llm,
		ledger: createLedger(null, "off"),
		snapshot: { ...snapshot(context()), ordinaryWorkspace: true },
		cycle: cycle(),
		signal: new AbortController().signal,
	});
	expect(result).toMatchObject({
		kind: "pause",
		reason: "goal_execution_wait",
	});
});
