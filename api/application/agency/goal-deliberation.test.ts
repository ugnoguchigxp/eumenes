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
	planInputs,
	SESSION_SYSTEM,
	stepOffered,
	type GoalCycle,
} from "./goal-deliberation";
import type { GoalCapability } from "./goal-progress-context";
import { THOUGHT_LIMIT, thoughtCounted } from "./goal-thought-budget";
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
	...partial,
});

const recall = {
	done: ["実装ファイルを読んだ", "監督に関連テストを頼んだ"],
	learned: ["背景色の選択と保存の実装がある"],
	failures: [
		{
			approach: "監督に関連テストを頼む",
			count: 3,
			cause: "監督の判断が確定しない",
			causeIn: "means",
		},
	],
};
const judge = (decision: string, extra: Record<string, unknown> = {}) => ({
	criteria: [{ id: "root", state: "likely", basis: "実装がある" }],
	decision,
	reason: "登録検査をまだ試していない",
	waitRef: null,
	question: null,
	missing: null,
	...extra,
});
const reflect = (decision: string, extra: Record<string, unknown> = {}) => ({
	differed: "検査が通らなかった",
	cause: "保存色を起動時に読んでいない",
	change: "読み取って原因を確かめる",
	decision,
	waitRef: null,
	question: null,
	missing: null,
	...extra,
});
const read = {
	kind: "act",
	capabilityRef: supervision,
	request: "起動時の背景色の読み込みを確かめる",
	expectedObservation: "読み込みの有無が分かる",
	criterionIds: ["root"],
};
const verify = {
	kind: "verify",
	checkRef,
	criterionId: "root",
	evidenceRefs: [],
};
const procedure = (...steps: unknown[]) => ({
	candidates: [
		{
			approach: "検査で確かめる",
			steps,
			impact: {
				changes: "none",
				reversible: true,
				minutes: 2,
				ifFails: "理由が残る",
			},
		},
	],
	chosen: 0,
	reason: "変更なしで条件を確かめられる",
});

/**
 * A model answering each stage of `goal-pursuit` from `byStage` (an array answers the stage's calls in order),
 * keeping every request; the stage is the one whose system context opens the last message.
 */
function model(byStage: Record<string, unknown>) {
	const asked: string[] = [];
	const requests: LlmRequest<unknown>[] = [];
	const calls = new Map<string, number>();
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>) {
			const messages = (request as { messages?: { content: string }[] })
				.messages!;
			const last = messages.at(-1)!.content;
			const stage = goalThoughtPlan.stages.find(({ system }) =>
				last.includes(system),
			)!;
			asked.push(stage.id);
			requests.push(request as LlmRequest<unknown>);
			const n = calls.get(stage.id) ?? 0;
			calls.set(stage.id, n + 1);
			const answer = byStage[stage.id];
			return {
				value: (Array.isArray(answer) ? answer[n] : answer) as T,
				model: "fixture",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	return { llm, asked, requests };
}
const turn = (
	llm: LlmPort,
	ctx: GoalStepContext,
	state: GoalCycle,
	ledger = createLedger(null, "off"),
	extra: { answered?: readonly string[]; verificationFailed?: boolean } = {},
) =>
	deliberateGoal({
		llm,
		ledger,
		snapshot: snapshot(ctx),
		cycle: state,
		signal: new AbortController().signal,
		...extra,
	});
const after = (state: GoalCycle, result: Awaited<ReturnType<typeof turn>>) =>
	({ ...state, ...result.cycle, pending: null }) as GoalCycle;

test("the stalled goal looks back, judges and devises in one session, and starts the procedure", async () => {
	const ctx = context();
	const { llm, asked, requests } = model({
		recall,
		judge: judge("continue"),
		devise: procedure(verify),
	});
	const result = await turn(llm, ctx, cycle());
	expect(asked).toEqual(["recall", "judge", "devise"]);
	expect(result).toMatchObject({
		kind: "step",
		step: {
			kind: "verify",
			contextId: "ctx-1",
			checks: [{ checkRef, criterionId: "root" }],
		},
		cycle: { thoughts: 1, remaining: [], current: { kind: "verify" } },
	});
	if (result.kind === "step") expect(stepOffered(ctx, result.step)).toBe(true);
	// One session: every stage goes under the same system, carrying the stages before it as messages.
	expect(requests.every(({ system }) => system === SESSION_SYSTEM)).toBe(true);
	const messages = (n: number) =>
		(requests[n] as unknown as { messages: { role: string }[] }).messages;
	expect(messages(0).map(({ role }) => role)).toEqual(["user"]);
	expect(messages(2).map(({ role }) => role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
		"user",
	]);
	expect(new Set(requests.map(({ session }) => session?.id)).size).toBe(1);
});

test("a step decided before, a due check, or a procedure on track: no model call", async () => {
	const ctx = context();
	const { llm, asked } = model({});
	const planned = {
		kind: "verify",
		checkRef,
		criterionId: "root",
		evidenceRefs: ["read:1"],
	} as const;
	expect(await turn(llm, ctx, cycle({ pending: planned }))).toMatchObject({
		kind: "step",
		step: { kind: "verify" },
		cycle: { pending: null },
	});
	const due = context({
		attempts: [
			{
				...context().attempts[0]!,
				outcome: "succeeded",
				evidenceRefs: ["read:1"],
			},
		],
		verificationRequired: { attemptRef: "attempt-1", criterionIds: ["root"] },
	});
	expect(await turn(llm, due, cycle())).toMatchObject({
		kind: "step",
		step: { kind: "verify", checks: [{ checkRef, evidenceRefs: ["read:1"] }] },
	});
	const done = context({
		attempts: [{ ...context().attempts[0]!, outcome: "succeeded" }],
	});
	const onTrack = await turn(
		llm,
		done,
		cycle({
			runId: "run-1",
			current: { step: "act read", kind: "act" },
			remaining: [planned],
			consumed: "attempt-0",
		}),
	);
	expect(onTrack).toMatchObject({
		kind: "step",
		step: { kind: "verify" },
		cycle: { remaining: [], since: [{ step: "act read" }] },
	});
	expect(asked).toEqual([]);
});

test("a step that went wrong opens the next round of the same session, which reflects and re-plans", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const ctx = context();
	const { llm, asked, requests } = model({
		recall,
		judge: judge("continue"),
		devise: [procedure(verify), procedure(read, verify)],
		reflect: reflect("replan"),
	});
	const first = await turn(llm, ctx, cycle(), ledger);
	const failed = await turn(llm, ctx, after(cycle(), first), ledger, {
		verificationFailed: true,
	});
	expect(asked).toEqual(["recall", "judge", "devise", "reflect", "devise"]);
	expect(failed).toMatchObject({
		kind: "step",
		step: { kind: "act", capabilityRef: supervision },
		cycle: { thoughts: 2, remaining: [verify] },
	});
	const reflectCall = requests[3]!;
	expect(reflectCall.session?.id).toBe(first.cycle!.runId!);
	expect(reflectCall.session?.turns).toHaveLength(3);
	expect(JSON.parse(reflectCall.prompt)).toMatchObject({
		result: { step: `verify ${checkRef} (root)`, outcome: "failed" },
	});
	expect(ledger.readRun(first.cycle!.runId!)?.run.rounds).toBe(2);
	store.close();
});

test("waiting on nothing in particular stops the goal for a while; asking ends the round with the question", async () => {
	const ctx = context();
	const waits = model({
		recall,
		judge: judge("wait", { waitRef: "recheck-later" }),
	});
	expect(await turn(waits.llm, ctx, cycle())).toMatchObject({
		kind: "pause",
		reason: "goal_wait_recheck",
		cycle: { thoughts: 1, current: { kind: "wait" } },
	});
	expect(waits.asked).toEqual(["recall", "judge"]);
	const asks = model({
		recall,
		judge: judge("ask", {
			question: "背景色を確かめる方法を指定できますか？",
			missing: "確かめ方",
		}),
	});
	expect(await turn(asks.llm, ctx, cycle())).toMatchObject({
		kind: "step",
		step: { kind: "ask", question: "背景色を確かめる方法を指定できますか？" },
	});
});

test("one autonomous run thinks at most four rounds, then asks once; the owner's answer starts a new session", async () => {
	const ctx = context();
	const { llm, asked } = model({});
	const spent = await turn(
		llm,
		ctx,
		cycle({
			runId: "run-1",
			current: { step: "verify", kind: "verify" },
			thoughts: THOUGHT_LIMIT,
			reason: "独立検査が不成立",
		}),
	);
	expect(asked).toEqual([]);
	expect(spent).toMatchObject({ kind: "step", step: { kind: "ask" } });
	if (spent.kind === "step" && spent.step.kind === "ask") {
		expect(spent.step.question).toContain(`${THOUGHT_LIMIT}回考えて進めました`);
		expect(spent.step.question).toContain("最後の判断: 独立検査が不成立");
	}
	const fresh = model({
		recall,
		judge: judge("continue"),
		devise: procedure(verify),
	});
	const answered = await turn(
		fresh.llm,
		ctx,
		cycle({ runId: "run-1", thoughts: THOUGHT_LIMIT, answers: ["q-old"] }),
		createLedger(null, "off"),
		// The old question went (its source lapsed); the new answer is still news.
		{ answered: ["q-new"] },
	);
	expect(fresh.asked).toEqual(["recall", "judge", "devise"]);
	expect(answered).toMatchObject({
		cycle: { thoughts: 1, answers: ["q-new"] },
	});
	expect(answered.cycle!.runId).not.toBe("run-1");
});

test("a session past its rounds asks the owner without the model", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const ctx = context();
	const { llm, asked } = model({
		recall,
		judge: judge("continue"),
		devise: procedure(verify),
		reflect: reflect("replan"),
	});
	let state = after(cycle(), await turn(llm, ctx, cycle(), ledger));
	for (let round = 2; round <= goalThoughtPlan.rounds!.max; round++)
		state = after(
			{ ...state, thoughts: 0 },
			await turn(llm, ctx, { ...state, thoughts: 0 }, ledger, {
				verificationFailed: true,
			}),
		);
	const calls = asked.length;
	const beyond = await turn(llm, ctx, { ...state, thoughts: 0 }, ledger, {
		verificationFailed: true,
	});
	expect(asked).toHaveLength(calls);
	expect(beyond).toMatchObject({ kind: "step", step: { kind: "ask" } });
	store.close();
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

test("a goal with much evidence still thinks: the goal's words and the newest evidence fit the first stage", () => {
	const evidence = [
		{ ref: "words", version: "1", summary: goalText },
		...Array.from({ length: 80 }, (_, n) => ({
			ref: `read:${80 - n}`,
			version: "1",
			summary: `読取結果${80 - n}：${"背景色".repeat(300)}`,
		})),
	];
	const inputs = planInputs(snapshot(context({ evidence })));
	const refs = inputs.evidence.map(({ ref }) => ref);
	expect(JSON.stringify(inputs).length).toBeLessThanOrEqual(36_000);
	expect(refs[0]).toBe("words");
	expect(refs).toContain("read:1");
	expect(refs).not.toContain("read:80");
	expect(inputs.waits.at(-1)?.ref).toBe("recheck-later");
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

test("a run that failed after reaching the model counts; one that never sent a call does not", () => {
	expect(thoughtCounted("goal_cycle_stage_output_inconsistent")).toBe(true);
	expect(thoughtCounted("goal_cycle_llm_timeout")).toBe(true);
	expect(thoughtCounted("goal_cycle_stage_input_too_large")).toBe(false);
	expect(thoughtCounted("goal_cycle_llm_preempted")).toBe(false);
	expect(thoughtCounted("goal_worker_unavailable")).toBe(false);
});

test("a next step no longer offered, or a step that never ran, goes back to the session instead of an old result", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const ctx = context({
		attempts: [{ ...context().attempts[0]!, outcome: "succeeded" }],
	});
	const { llm, asked, requests } = model({
		recall,
		judge: judge("continue"),
		devise: [procedure(read, verify), procedure(verify)],
		reflect: reflect("replan"),
	});
	const first = await turn(llm, ctx, cycle(), ledger);
	expect(first).toMatchObject({
		cycle: { consumed: "attempt-1", remaining: [verify] },
	});
	// The read was taken but no newer attempt came back: the old success is not read as its result.
	const next = await turn(llm, ctx, after(cycle(), first), ledger);
	expect(asked).toEqual(["recall", "judge", "devise", "reflect", "devise"]);
	expect(JSON.parse(requests[3]!.prompt)).toMatchObject({
		result: { outcome: "rejected" },
	});
	expect(next).toMatchObject({ step: { kind: "verify" } });

	// A next step whose check is no longer offered is not taken; the session hears it could not run.
	const later = context({
		checks: [],
		attempts: [
			...ctx.attempts,
			{ ...ctx.attempts[0]!, ref: "attempt-2", outcome: "succeeded" },
		],
	});
	const blocked = model({
		reflect: reflect("ask", {
			question: "検査を用意できますか？",
			missing: "検査",
		}),
	});
	const asking = await turn(
		blocked.llm,
		later,
		cycle({
			runId: first.cycle!.runId!,
			current: { step: "act read", kind: "act" },
			remaining: [verify as never],
			consumed: "attempt-1",
		}),
		ledger,
	);
	expect(blocked.asked).toEqual(["reflect"]);
	expect(JSON.parse(blocked.requests[0]!.prompt)).toMatchObject({
		result: { step: `verify ${checkRef} (root)`, outcome: "rejected" },
	});
	expect(asking).toMatchObject({ step: { kind: "ask" } });
	store.close();
});
