import { afterEach, expect, test } from "bun:test";
import type { IntentInput, IntentJudgment } from "../../inference";
import { waitFor } from "../../../infrastructure/wait-for";
import { intentJudgmentsOfMessage } from "../repository/intent";
import { routeOf } from "../service/intent-gate";
import { IMAGE, setup, type Harness } from "./generation.fixture";
import { settings, type Snapshot } from "./harness.fixture";

/**
 * The user-intent judge before the first model call (the intent gate design, sections 5 and 6): `shadow` records it
 * and leaves the routing as it is; `ruri` asks for the search first on a confident `request`, lets no tool be called
 * on talk (`chat`, `noise`, `incomplete`) and leaves a reply to work to the model; a failure keeps today's routing;
 * every judgement is recorded with what the model then did.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const judgment = (
	choice: IntentJudgment["choice"],
	request: number,
): IntentJudgment => ({
	choice,
	probabilities: {
		request,
		chat: choice === "chat" ? 1 - request : 0,
		followup: choice === "followup" ? 1 - request : 0,
		noise: choice === "noise" ? 1 - request : 0,
		incomplete: choice === "incomplete" ? 1 - request : 0,
	},
	model: "judge-fixture-model",
	headRevision: "head-1",
	truncated: false,
	historyTokensDropped: 0,
	stateTokensDropped: 0,
});

async function start(
	intent: Partial<Snapshot["intent"]>,
	judge: (input: IntentInput, signal: AbortSignal) => Promise<IntentJudgment>,
) {
	h = await setup({
		settings: {
			...settings({ mode: "larm-only" }),
			intent: {
				mode: "shadow",
				profile: "judge-fixture-profile",
				timeoutMs: 1500,
				searchScore: 0.6,
				...intent,
			},
		} as Snapshot,
	});
	const asked: IntentInput[] = [];
	Object.assign(h.larm, {
		judgeIntent: (input: IntentInput, signal: AbortSignal) => {
			asked.push(input);
			return judge(input, signal);
		},
	});
	return asked;
}
const recorded = (messageId: string) =>
	h!.store.read((db) => intentJudgmentsOfMessage(db, messageId));
/** The last section of a call's system part. */
const lastSection = (call: { messages: Array<{ content: string }> }) =>
	call.messages[0]!.content.split("\n\n## ").at(-1)!;

test("shadow asks the judge with the newest utterance and the agent's words before it, records it, and routes as today", async () => {
	const asked = await start({ mode: "shadow" }, async () =>
		judgment("request", 0.9),
	);
	h!.state.steps.push({ text: "こんにちは。" });
	await h!.say("こんにちは");
	h!.state.steps.push({ text: "晴れです。" });
	const run = await h!.say("明日の天気を調べて");
	expect(asked.at(-1)).toEqual({
		text: "明日の天気を調べて",
		previousAgent: "こんにちは。",
	});
	// The first call of the turn is today's: no tool is required, and the system part states no judgement.
	expect(h!.state.calls.at(-1)!.session?.toolChoice).toBeUndefined();
	expect(h!.state.calls.at(-1)!.messages[0]!.content).not.toContain(
		"## Intent",
	);
	await waitFor(() => recorded(run.inputMessageId)[0]?.observedSearch !== null);
	expect(recorded(run.inputMessageId)).toEqual([
		expect.objectContaining({
			runId: run.id,
			mode: "shadow",
			model: "judge-fixture-model",
			headRevision: "head-1",
			choice: "request",
			legacyRoute: "free",
			finalRoute: "free",
			fallbackReason: null,
			observedSearch: 0,
			observedDelegate: 0,
		}),
	]);
	expect(
		JSON.parse(recorded(run.inputMessageId)[0]!.probabilities!),
	).toMatchObject({ request: 0.9 });
});

test("ruri asks for the search first on a confident request: the first call requires a tool, and another tool before the search is refused", async () => {
	await start({ mode: "ruri" }, async () => judgment("request", 0.8));
	h!.state.steps.push(
		{ calls: [{ name: "work", args: { todo: "t1", operation: "check" } }] },
		{ calls: [{ name: "find_toolchain", args: { query: "猫の絵を描く" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const run = await h!.say("猫の絵を描いて", "queued");
	expect(h!.state.calls[0]!.session?.toolChoice).toBe("required");
	// The system part ends with the judgement, in every call of the turn.
	for (const call of h!.state.calls)
		expect(lastSection(call)).toBe(
			"Intent\n- 利用者の今の発言は、担当への依頼です（意図の判定）。担当を探して、今の発言の内容を頼みます。",
		);
	// The refused call is answered with its reason; only the first call required a tool, and the model may answer in
	// words from then on. Here it searches and hands the work over.
	expect(h!.state.calls[1]!.messages.at(-1)!.content).toContain("search_first");
	expect(h!.state.calls[1]!.session?.toolChoice).toBeUndefined();
	expect(h!.state.calls[2]!.session?.toolChoice).toBeUndefined();
	await waitFor(() => recorded(run.inputMessageId)[0]?.observedDelegate === 1);
	expect(recorded(run.inputMessageId)[0]).toMatchObject({
		mode: "ruri",
		choice: "request",
		finalRoute: "search",
		observedSearch: 1,
	});
});

test("ruri leaves a reply to work and an unsure request to the model; the model may use any tool", async () => {
	for (const [choice, request] of [
		["request", 0.4],
		["followup", 0.2],
	] as const) {
		await start({ mode: "ruri" }, async () => judgment(choice, request));
		h!.state.steps.push({ text: "はい。" });
		const run = await h!.say("それで");
		expect(h!.state.calls[0]!.session?.toolChoice).toBeUndefined();
		expect(h!.state.calls[0]!.messages[0]!.content).not.toContain("## Intent");
		expect(recorded(run.inputMessageId)[0]).toMatchObject({
			choice,
			finalRoute: "free",
		});
		await h!.close();
		h = undefined;
	}
	expect(routeOf(judgment("request", 0.6), 0.6)).toBe("search");
	expect(routeOf(judgment("request", 0.59), 0.6)).toBe("free");
});

test("ruri lets no tool be called on talk: the turn's calls keep the tools with no call allowed, and a call that still comes is refused", async () => {
	for (const choice of ["chat", "noise", "incomplete"] as const) {
		await start({ mode: "ruri" }, async () => judgment(choice, 0.05));
		h!.state.steps.push(
			{ calls: [{ name: "find_toolchain", args: { query: "音楽" } }] },
			{ text: "こんばんは。" },
		);
		const run = await h!.say("こんばんは");
		expect(h!.dialogue.answerText(run.id)).toBe("こんばんは。");
		expect(h!.state.calls.map((c) => c.session?.toolChoice)).toEqual([
			"none",
			"none",
		]);
		expect(lastSection(h!.state.calls[0]!)).toBe(
			"Intent\n- 利用者の今の発言は、担当への依頼ではありません（意図の判定）。担当やツールは使わず、話して返します。",
		);
		expect(h!.state.calls[0]!.tools).toEqual([
			"memory",
			"find_toolchain",
			"delegate",
			"work",
		]);
		expect(h!.state.calls[1]!.messages.at(-1)!.content).toContain(
			"tools_not_needed",
		);
		await waitFor(() => recorded(run.inputMessageId)[0]?.observedSearch === 0);
		expect(recorded(run.inputMessageId)[0]).toMatchObject({
			choice,
			finalRoute: "answer",
		});
		await h!.close();
		h = undefined;
	}
	expect(routeOf(judgment("chat", 0.9), 0.6)).toBe("answer");
});

test("a failed or late judge keeps today's routing and the conversation goes on", async () => {
	for (const [intent, judge, reason] of [
		[
			{ mode: "ruri" },
			async () => {
				throw new Error("larm_invalid_intent_response");
			},
			"larm_invalid_intent_response",
		],
		[
			{ mode: "ruri", timeoutMs: 100 },
			(_input: IntentInput, signal: AbortSignal) =>
				new Promise<IntentJudgment>((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason)),
				),
			"timeout",
		],
	] as const) {
		await start(intent, judge);
		h!.state.steps.push({ text: "晴れです。" });
		const run = await h!.say("明日の天気は");
		expect(h!.state.calls[0]!.session?.toolChoice).toBeUndefined();
		expect(h!.state.calls[0]!.messages[0]!.content).not.toContain("## Intent");
		expect(recorded(run.inputMessageId)[0]).toMatchObject({
			mode: "ruri",
			choice: null,
			finalRoute: "free",
			fallbackReason: reason,
		});
		await h!.close();
		h = undefined;
	}
});

test("legacy, or a judge without a saved profile, asks nothing and records nothing", async () => {
	for (const intent of [
		{ mode: "legacy" },
		{ mode: "ruri", profile: undefined },
	] as const) {
		const asked = await start(intent, async () => judgment("request", 1));
		h!.state.steps.push({ text: "晴れです。" });
		const run = await h!.say("明日の天気は");
		expect(asked).toEqual([]);
		expect(recorded(run.inputMessageId)).toEqual([]);
		expect(h!.state.calls[0]!.session?.toolChoice).toBeUndefined();
		await h!.close();
		h = undefined;
	}
});

test("a judgement belongs to its own run: a cancelled run's judgement stops with it and lends nothing to the next", async () => {
	const asked = await start({ mode: "ruri" }, (input, signal) =>
		input.text === "猫の"
			? new Promise<IntentJudgment>((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason)),
				)
			: Promise.resolve(judgment("chat", 0.05)),
	);
	const cancelled = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "猫の",
	});
	await waitFor(() => asked.length === 1);
	await h!.dialogue.cancel(cancelled.id);
	await waitFor(() => h!.dialogue.get(cancelled.id)?.status === "cancelled");
	const first = h!.dialogue.get(cancelled.id)!;
	await waitFor(() => recorded(first.inputMessageId).length === 1);
	expect(recorded(first.inputMessageId)[0]).toMatchObject({
		choice: null,
		finalRoute: "free",
		fallbackReason: "cancelled",
	});
	expect(h!.state.calls).toEqual([]);
	h!.state.steps.push({ text: "わかりました。" });
	const next = await h!.say("やっぱりいいや");
	// Its own judgement (talk) routes it, not the cancelled one's.
	expect(h!.state.calls[0]!.session?.toolChoice).toBe("none");
	expect(recorded(next.inputMessageId)).toEqual([
		expect.objectContaining({ choice: "chat", finalRoute: "answer" }),
	]);
	expect(recorded(first.inputMessageId)).toHaveLength(1);
});
