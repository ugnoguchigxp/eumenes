import { afterEach, expect, test } from "bun:test";
import type { IntentInput, IntentJudgment } from "../../inference";
import { waitFor } from "../../../infrastructure/wait-for";
import { intentJudgmentsOfMessage } from "../repository/intent";
import { routeOf } from "../service/intent-gate";
import { IMAGE, setup, type Harness } from "./generation.fixture";
import { settings, type Snapshot } from "./harness.fixture";

/**
 * The user-intent judge before the first model call (the intent gate design, section 5; the local harness rebuild
 * plan, section 4.1): `ruri` routes a confident `request` to the request turn (the host searches, one choice) and
 * anything else to the talk turn; `shadow`, a failure or no judge leave it to the request turn, whose choice may be
 * none. Every judgement is recorded with what the turn then did.
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
		harness: "local",
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

/** A routed turn's choice as the model answers it. */
const choice = (value: Record<string, unknown>) => ({
	text: JSON.stringify(value),
});

test("shadow asks the judge with the newest utterance and the agent's words before it, records it, and leaves the turn to the request turn", async () => {
	const asked = await start({ mode: "shadow" }, async () =>
		judgment("request", 0.9),
	);
	h!.state.steps.push(choice({ choice: "none" }), { text: "こんにちは。" });
	await h!.say("こんにちは");
	h!.state.steps.push(choice({ choice: "none" }), { text: "晴れです。" });
	const run = await h!.say("明日の天気を調べて");
	expect(asked.at(-1)).toEqual({
		text: "明日の天気を調べて",
		previousAgent: "こんにちは。",
	});
	// The routing is not the judge's: the request turn chose, then talked.
	expect(h!.state.calls.at(-2)!.session?.outputSchema).toBeDefined();
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
			observedSearch: 1,
			observedDelegate: 0,
		}),
	]);
	expect(
		JSON.parse(recorded(run.inputMessageId)[0]!.probabilities!),
	).toMatchObject({ request: 0.9 });
});

test("ruri takes a confident request to the request turn: the host searches with the words, and one silent choice hands it over", async () => {
	await start({ mode: "ruri" }, async () => judgment("request", 0.8));
	h!.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
	);
	const run = await h!.say("猫の絵を描いて", "queued");
	expect(h!.state.calls).toHaveLength(1);
	const [chose] = h!.state.calls;
	expect(chose!.tools).toEqual([]);
	expect(chose!.session?.outputSchema).toBeDefined();
	expect(chose!.messages.at(-1)!.content).toContain("## User\n猫の絵を描いて");
	await waitFor(() => recorded(run.inputMessageId)[0]?.observedDelegate === 1);
	expect(recorded(run.inputMessageId)[0]).toMatchObject({
		mode: "ruri",
		choice: "request",
		finalRoute: "search",
		observedSearch: 1,
	});
});

test("ruri takes anything else to the talk turn: one streamed call with no tools and no choice", async () => {
	for (const [label, request] of [
		["chat", 0.05],
		["noise", 0.05],
		["incomplete", 0.05],
		["followup", 0.2],
		["request", 0.4],
	] as const) {
		await start({ mode: "ruri" }, async () => judgment(label, request));
		h!.state.steps.push({ text: "こんばんは。" });
		const run = await h!.say("こんばんは");
		expect(h!.dialogue.answerText(run.id)).toBe("こんばんは。");
		expect(h!.state.calls).toHaveLength(1);
		expect(h!.state.calls[0]!.tools).toEqual([]);
		expect(h!.state.calls[0]!.session?.outputSchema).toBeUndefined();
		expect(h!.state.calls[0]!.session?.toolChoice).toBeUndefined();
		await waitFor(() => recorded(run.inputMessageId)[0]?.observedSearch === 0);
		expect(recorded(run.inputMessageId)[0]).toMatchObject({
			choice: label,
			finalRoute: "answer",
		});
		await h!.close();
		h = undefined;
	}
	expect(routeOf(judgment("request", 0.6), 0.6, false)).toBe("search");
	expect(routeOf(judgment("request", 0.59), 0.6, false)).toBe("answer");
	expect(routeOf(judgment("chat", 0.9), 0.6, true)).toBe("answer");
	// A reply to the work goes to the request turn only while there is work it may check, correct or cancel.
	expect(routeOf(judgment("followup", 0.2), 0.6, true)).toBe("search");
	expect(routeOf(judgment("followup", 0.2), 0.6, false)).toBe("answer");
});

test("ruri takes a reply to the work to the request turn while there is work: a check reads it, the talk turn tells it, and nothing starts", async () => {
	const judged = [judgment("request", 0.8), judgment("followup", 0.2)];
	await start({ mode: "ruri" }, async () => judged.shift()!);
	h!.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
	);
	await h!.say("猫の絵を描いて", "queued");
	h!.state.steps.push(choice({ choice: "t1", operation: "check" }), {
		text: "まだ描いています。",
	});
	const run = await h!.say("さっきの絵はどうなった？");
	expect(h!.dialogue.answerText(run.id)).toBe("まだ描いています。");
	const [chose, talked] = h!.state.calls.slice(-2);
	expect(JSON.stringify(chose!.session?.outputSchema)).toContain('"check"');
	expect(talked!.session?.outputSchema).toBeUndefined();
	expect(talked!.messages.at(-1)!.content).toContain(
		"仕事の記録を確かめた結果です",
	);
	expect(talked!.messages.at(-1)!.content).toContain("t1");
	expect(h!.todos()).toHaveLength(1);
	await waitFor(() => recorded(run.inputMessageId)[0]?.observedSearch === 1);
	expect(recorded(run.inputMessageId)[0]).toMatchObject({
		choice: "followup",
		finalRoute: "search",
	});
});

test("a failed or late judge leaves the turn to the request turn and the conversation goes on", async () => {
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
		h!.state.steps.push(choice({ choice: "none" }), { text: "晴れです。" });
		const run = await h!.say("明日の天気は");
		expect(h!.dialogue.answerText(run.id)).toBe("晴れです。");
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
		h!.state.steps.push(choice({ choice: "none" }), { text: "晴れです。" });
		const run = await h!.say("明日の天気は");
		expect(asked).toEqual([]);
		expect(recorded(run.inputMessageId)).toEqual([]);
		expect(h!.dialogue.answerText(run.id)).toBe("晴れです。");
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
	// Its own judgement (talk) routes it, not the cancelled one's: one talk call, no choice.
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.calls[0]!.session?.outputSchema).toBeUndefined();
	expect(recorded(next.inputMessageId)).toEqual([
		expect.objectContaining({ choice: "chat", finalRoute: "answer" }),
	]);
	expect(recorded(first.inputMessageId)).toHaveLength(1);
});
