import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Utterance } from "../../conversation";
import type { DialogueDeps, GenerateInput } from "../service/context";
import { conversationPrefixFrom } from "../service/conversation-input";
import {
	localHarness,
	routeConversation,
	type ConversationHarness,
} from "../service/harness";
import { runRoutedTurn } from "../service/routed-turn";
import { OTHER, RESOURCE, settings, type Snapshot } from "./harness.fixture";
import { testConversationAgent } from "./conversation-agent.fixture";
import { setup, type Harness } from "./generation.fixture";
import { waitFor } from "../../../infrastructure/wait-for";

/**
 * The conversation harness (the conversation harness design, sections 4.1 to 4.3; the single harness plan): its
 * one value, the model's route chosen from the saved settings, and what each part of the value changes.
 */
test("the harness: the routed turn's talk on the last two utterances, thinking at low within 4,096 tokens", () => {
	expect(localHarness.gates).toEqual({ systemCopy: true });
	expect(localHarness.history).toEqual({ copyFilter: true, users: 2 });
	expect(localHarness.call).toEqual({ reasoning: "low", outputLimit: 4096 });
});

test("the llm route is LARM only unless the saved route picks a usable cloud model", () => {
	for (const mode of ["larm-only", "larm-preferred"] as const) {
		const snapshot = settings({ mode });
		const speech = structuredClone([snapshot.routes.asr, snapshot.routes.tts]);
		routeConversation(snapshot);
		expect(snapshot.routes.llm.mode).toBe("larm-only");
		expect(snapshot.routes.llm.cloudAllowed).toBe(false);
		// Speech keeps its saved routes: recognition falls back to the cloud after a LARM timeout.
		expect([snapshot.routes.asr, snapshot.routes.tts]).toEqual(speech);
	}
	for (const unusable of [
		{ enabled: false },
		{ fallbackId: null },
		{ fallbackId: OTHER },
		{ purpose: "asr" as const },
	]) {
		const snapshot = settings({ mode: "cloud-only", ...unusable });
		routeConversation(snapshot);
		expect(snapshot.routes.llm.mode).toBe("larm-only");
		expect(snapshot.routes.llm.cloudAllowed).toBe(false);
	}
});

test("a usable saved cloud model is the llm route; speech routes are left as saved", () => {
	for (const kind of ["codex-sdk", "claude-agent-sdk"] as const) {
		const snapshot = settings({ mode: "cloud-only", kind });
		routeConversation(snapshot);
		expect(snapshot.routes.llm).toMatchObject({
			mode: "cloud-only",
			cloudAllowed: true,
			fallbackId: RESOURCE,
		});
		for (const p of ["asr", "tts"] as const)
			expect(snapshot.routes[p]).toMatchObject({
				mode: "larm-preferred",
				cloudAllowed: true,
			});
	}
});

test("the copy filter leaves out an agent's utterance that copies the system part, and only when the flag is on", () => {
	const system = "## Role\n曲を生成します。: 完成と名前を短く伝えます。";
	const utterance = (
		seq: number,
		speaker: "user" | "agent",
		text: string,
	): Utterance => ({
		conversationId: "c1",
		seq,
		speaker,
		text,
		messageId: `m${seq}`,
		at: "2026-10-26T10:00:00.000Z",
		toolCalls: [],
		notice: null,
	});
	const deps = {
		conversation: {
			input: {
				cutInTransaction: () => null,
				utterancesAfterInTransaction: () => [
					utterance(1, "agent", "曲を生成します。: 完成と名前を短く伝えます。"),
					utterance(2, "agent", "おはようございます"),
				],
				latestUtterancesInTransaction: () => [],
			},
		},
	} as unknown as DialogueDeps;
	const draw = (harness: ConversationHarness) =>
		conversationPrefixFrom(deps, {} as Database, "c1", {
			harness,
			system,
			window: null,
			pending: new Set(),
		}).recent.map((u) => u.text);
	expect(draw(localHarness)).toEqual(["おはようございます"]);
	expect(
		draw({
			...localHarness,
			history: { ...localHarness.history, copyFilter: false },
		}),
	).toHaveLength(2);
});

test("an answer that copies the system part fails only while the harness's gate is on", async () => {
	const system = "## Role\n曲を生成します。: 完成と名前を短く伝えます。";
	const copied = "曲を生成します。: 完成と名前を短く伝えます。";
	const generate = (harness: ConversationHarness) =>
		runRoutedTurn(
			{
				larm: { answer: async () => copied },
				conversationAgent: testConversationAgent,
			} as unknown as DialogueDeps,
			{
				harness,
				final: { kind: "utterances", messageIds: [] },
				utterances: [],
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: "## User\nこんにちは" },
				],
			} as unknown as GenerateInput,
			{
				signal: new AbortController().signal,
				delta: () => {},
				execute: async () => ({ result: null }),
			},
		);
	// The copy stops the talk call as it streams: the turn says the host's words, never the copy.
	expect((await generate(localHarness)).text).toBe(
		"うまく答えられませんでした。もう一度言ってもらえますか。",
	);
	const open = { ...localHarness, gates: { systemCopy: false } };
	expect((await generate(open)).text).toBe(copied);
});

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const lastCall = () => h!.state.calls.at(-1)!;
/** Every call carries the one reasoning level for both sides: LARM and a cloud connection. */
const BOTH = {
	larm: localHarness.call.reasoning,
	cloud: localHarness.call.reasoning,
};

/** A routed turn with no judgement: the request turn chooses nothing, then the talk turn says `text`. */
const talked = (text: string) => [
	{ text: JSON.stringify({ choice: "none" }) },
	{ text },
];

test("a run is the routed turn: its calls carry the harness's limit and reasoning", async () => {
	h = await setup();
	h.state.steps.push(...talked("はい"));
	await h.say("こんにちは");
	expect(lastCall().session).toMatchObject({
		sessionRole: "main",
		outputLimit: 4096,
		reasoning: BOTH,
	});
});

test("a run takes the saved cloud model's route and runs the same routed turn: the same limit and the same talk system", async () => {
	h = await setup({ settings: settings({ mode: "larm-only" }) });
	h.state.steps.push(...talked("a"), ...talked("b"));
	await h.say("こんにちは");
	await h.say("もう一度");
	expect(h.state.captures).toHaveLength(2);
	expect(h.state.calls.map((c) => c.session?.outputLimit)).toEqual([
		4096, 4096, 4096, 4096,
	]);
	const talk = h.state.calls.at(-1)!.messages[0]!.content;
	expect(talk).not.toContain("## Toolchains");
	expect(talk).not.toContain("find_toolchain");
	await h.close();

	h = await setup({ settings: settings({ mode: "cloud-only" }) });
	h.state.steps.push(...talked("a"), ...talked("b"));
	await h.say("こんにちは");
	await h.say("もう一度");
	const capture = h.state.captures[0]!;
	expect(capture.purpose).toBe("llm");
	expect((capture.snapshot as Snapshot).routes.llm).toMatchObject({
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: RESOURCE,
	});
	expect(h.state.calls.map((c) => c.session)).toEqual(
		Array.from({ length: 4 }, () =>
			expect.objectContaining({ outputLimit: 4096, reasoning: BOTH }),
		),
	);
	const cloudTalk = h.state.calls.at(-1)!.messages[0]!.content;
	expect(cloudTalk).not.toContain("## Toolchains");
});

test("a saved cloud model that can not be used falls back to LARM", async () => {
	h = await setup({
		settings: settings({ mode: "cloud-only", enabled: false }),
		lateCapture: true,
	});
	h.state.steps.push(...talked("はい"));
	await h.say("こんにちは");
	expect((h.state.captures[0]!.snapshot as Snapshot).routes.llm).toMatchObject({
		mode: "larm-only",
		cloudAllowed: false,
	});
	expect(lastCall().session).toMatchObject({
		outputLimit: 4096,
		reasoning: BOTH,
	});
});

test("a run accepted keeps the saved route as it is: a LARM-preferred one stays so", async () => {
	h = await setup({ settings: settings({ mode: "larm-preferred" }) });
	h.state.steps.push(...talked("はい"));
	await h.say("こんにちは");
	expect(h.state.captures).toHaveLength(1);
	expect((h.state.captures[0]!.snapshot as Snapshot).routes.llm).toMatchObject({
		mode: "larm-preferred",
		cloudAllowed: true,
	});
	expect(lastCall().session).toMatchObject({
		outputLimit: 4096,
		reasoning: BOTH,
	});
});

test("a run captured at prepare pins speech to LARM and routes the llm as the saved route picks", async () => {
	h = await setup({
		settings: settings({ mode: "cloud-only" }),
		lateCapture: true,
	});
	h.state.steps.push(...talked("はい"));
	await h.say("こんにちは");
	expect(h.state.captures).toHaveLength(1);
	const { routes } = h.state.captures[0]!.snapshot as Snapshot;
	expect(routes.llm).toMatchObject({ mode: "cloud-only", cloudAllowed: true });
	for (const p of ["asr", "tts"] as const)
		expect(routes[p]).toMatchObject({ mode: "larm-only", cloudAllowed: false });
	expect(lastCall().session).toMatchObject({
		outputLimit: 4096,
		reasoning: BOTH,
	});
});

test("a resubmitted utterance is captured with the saved route as it is", async () => {
	h = await setup({
		settings: settings({ mode: "larm-preferred" }),
		autoStart: false,
	});
	const first = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "A",
	});
	const result = await h.dialogue.resubmit("main", first.inputMessageId, {
		requestId: crypto.randomUUID(),
		text: "B",
	});
	if (!result.ok) throw new Error(result.code);
	const capture = h.state.captures.find((c) => c.subject === result.run.id)!;
	expect((capture.snapshot as Snapshot).routes.llm).toMatchObject({
		mode: "larm-preferred",
		cloudAllowed: true,
	});
	h.state.steps.push(...talked("Bです。"));
	h.start();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
});
