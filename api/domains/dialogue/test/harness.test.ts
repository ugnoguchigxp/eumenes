import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Utterance } from "../../conversation";
import type { DialogueDeps, GenerateInput } from "../service/context";
import { SYSTEM_SECTIONS, systemText } from "../service/context-system";
import {
	conversationPrefixFrom,
	recentMessages,
} from "../service/conversation-input";
import { runGeneration } from "../service/generation-loop";
import {
	cloudHarness,
	harnessFor,
	harnessOf,
	localHarness,
	routeConversation,
	type ConversationHarness,
} from "../service/harness";
import { OTHER, RESOURCE, settings, type Snapshot } from "./harness.fixture";
import { testConversationAgent } from "./conversation-agent.fixture";
import { setup, type Harness } from "./generation.fixture";
import { waitFor } from "../../../infrastructure/wait-for";

/**
 * The conversation harness (the conversation harness design, sections 4.1 to 4.3): the two values, the choice from
 * the saved route, and what each part of a value changes. Step 1: both values compose the messages of today and
 * differ only in the call's settings.
 */
test("the two values differ in the recent conversation and the call's settings: local draws the words alone", () => {
	expect(cloudHarness.name).toBe("cloud");
	expect(localHarness.name).toBe("local");
	for (const harness of [cloudHarness, localHarness]) {
		expect(harness.system).toEqual(SYSTEM_SECTIONS);
		expect(harness.gates).toEqual({ systemCopy: true });
	}
	expect(cloudHarness.history).toEqual({
		toolExchanges: true,
		notices: true,
		copyFilter: true,
	});
	expect(localHarness.history).toEqual({
		toolExchanges: false,
		notices: false,
		copyFilter: true,
	});
	expect(cloudHarness.call).toEqual({ reasoning: "low", outputLimit: 1024 });
	expect(localHarness.call).toEqual({ reasoning: "low", outputLimit: 4096 });
});

test("LARM is served with the local harness, every cloud connection kind with the cloud one", () => {
	expect(harnessFor("larm")).toBe(localHarness);
	for (const kind of [
		"codex-sdk",
		"claude-agent-sdk",
		"openai-compatible",
		"cloudflare-workers-ai",
		undefined,
	] as const)
		expect(harnessFor(kind)).toBe(cloudHarness);
});

test("the llm route is LARM only and the harness local unless the saved route picks a usable cloud model", () => {
	for (const mode of ["larm-only", "larm-preferred"] as const) {
		const snapshot = settings({ mode });
		const speech = structuredClone([snapshot.routes.asr, snapshot.routes.tts]);
		routeConversation(snapshot);
		expect(harnessOf(snapshot)).toBe(localHarness);
		expect(snapshot.routes.llm.mode).toBe("larm-only");
		expect(snapshot.routes.llm.cloudAllowed).toBe(false);
		// Speech keeps its saved routes: recognition falls back to the cloud after a LARM timeout.
		expect([snapshot.routes.asr, snapshot.routes.tts]).toEqual(speech);
	}
	expect(harnessOf(null)).toBe(localHarness);
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
		expect(harnessOf(snapshot)).toBe(localHarness);
	}
});

test("a usable saved cloud model is the llm route, with the cloud harness; speech routes are left as saved", () => {
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
		expect(harnessOf(snapshot)).toBe(cloudHarness);
	}
});

test("the system part is written in the harness's sections and order", () => {
	const persona = { agentName: "", userName: "", persona: "butler" as const };
	const agent = { base: "B", toolRules: "T" };
	expect(systemText(persona, agent, ["音楽"])).toBe(
		systemText(persona, agent, ["音楽"], SYSTEM_SECTIONS),
	);
	const text = systemText(persona, agent, [], ["Tools", "Role"]);
	expect(text.match(/^## .+$/gm)).toEqual(["## Tools", "## Role"]);
});

test("a history flag turned off leaves out only its part of the recent conversation", () => {
	const at = "2026-10-26T10:00:00.000Z";
	const said = (
		seq: number,
		speaker: "user" | "agent",
		text: string,
		extra: Partial<Utterance> = {},
	): Utterance => ({
		conversationId: "c1",
		seq,
		speaker,
		text,
		messageId: `m${seq}`,
		at,
		toolCalls: [],
		notice: null,
		...extra,
	});
	const utterances = [
		said(1, "agent", "できました", { notice: "[ホストの知らせ] t1" }),
		said(2, "user", "はい"),
		said(3, "agent", "作ります", {
			toolCalls: [{ name: "find_toolchain", arguments: "{}", result: "{}" }],
		}),
		said(4, "agent", "報告です", { notice: "[ホストの知らせ] t2" }),
	];
	const all = cloudHarness.history;
	const roles = (history: ConversationHarness["history"]) =>
		recentMessages(utterances, history).map((m) => m.role);
	expect(roles(localHarness.history)).toEqual([
		"assistant",
		"user",
		"assistant",
	]);
	const joined = (history: ConversationHarness["history"]) =>
		recentMessages(utterances, history)
			.map((m) => m.content)
			.join("\n");
	expect(roles(all)).toContain("tool");
	expect(joined(all)).toContain("[ホストの知らせ] t2");
	const noExchange = { ...all, toolExchanges: false };
	expect(roles(noExchange)).not.toContain("tool");
	expect(joined(noExchange)).toContain("[ホストの知らせ] t2");
	const noNotice = { ...all, notices: false };
	expect(roles(noNotice)).toContain("tool");
	expect(joined(noNotice)).not.toContain("[ホストの知らせ]");
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
		runGeneration(
			{
				larm: { answer: async () => copied },
				conversationAgent: testConversationAgent,
			} as unknown as DialogueDeps,
			{
				harness,
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
	await expect(generate(localHarness)).rejects.toThrow("system_text_copied");
	const open = { ...localHarness, gates: { systemCopy: false } };
	expect((await generate(open)).text).toBe(copied);
});

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const lastCall = () => h!.state.calls.at(-1)!;
/** Every call carries both sides' reasoning: LARM answers with the local harness's, a cloud with the cloud's. */
const BOTH = {
	larm: localHarness.call.reasoning,
	cloud: cloudHarness.call.reasoning,
};

test("a run with the default settings is served with the local harness: the call carries its limit and reasoning", async () => {
	h = await setup();
	h.state.steps.push({ text: "はい" });
	await h.say("こんにちは");
	expect(lastCall().session).toMatchObject({
		sessionRole: "main",
		outputLimit: 4096,
		reasoning: BOTH,
	});
});

test("a run takes the saved cloud model's route and harness, and the messages are the local harness's", async () => {
	h = await setup({ settings: settings({ mode: "larm-only" }) });
	h.state.steps.push({ text: "a" }, { text: "b" });
	await h.say("こんにちは");
	await h.say("もう一度");
	const local = h.state.calls.map((c) => c.messages);
	expect(h.state.captures).toHaveLength(2);
	expect(h.state.calls.map((c) => c.session?.outputLimit)).toEqual([
		4096, 4096,
	]);
	await h.close();

	h = await setup({ settings: settings({ mode: "cloud-only" }) });
	h.state.steps.push({ text: "a" }, { text: "b" });
	await h.say("こんにちは");
	await h.say("もう一度");
	const capture = h.state.captures[0]!;
	expect(capture.purpose).toBe("llm");
	expect((capture.snapshot as Snapshot).routes.llm).toMatchObject({
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: RESOURCE,
	});
	expect(h.state.calls.map((c) => c.session)).toEqual([
		expect.objectContaining({ outputLimit: 1024, reasoning: BOTH }),
		expect.objectContaining({ outputLimit: 1024, reasoning: BOTH }),
	]);
	expect(h.state.calls.map((c) => c.messages)).toEqual(local);
});

test("a saved cloud model that can not be used falls back to LARM and the local harness", async () => {
	h = await setup({
		settings: settings({ mode: "cloud-only", enabled: false }),
		lateCapture: true,
	});
	h.state.steps.push({ text: "はい" });
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

test("a run accepted keeps the saved route as it is: a LARM-preferred one stays so, and keeps the local harness", async () => {
	h = await setup({ settings: settings({ mode: "larm-preferred" }) });
	h.state.steps.push({ text: "はい" });
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
	h.state.steps.push({ text: "はい" });
	await h.say("こんにちは");
	expect(h.state.captures).toHaveLength(1);
	const { routes } = h.state.captures[0]!.snapshot as Snapshot;
	expect(routes.llm).toMatchObject({ mode: "cloud-only", cloudAllowed: true });
	for (const p of ["asr", "tts"] as const)
		expect(routes[p]).toMatchObject({ mode: "larm-only", cloudAllowed: false });
	expect(lastCall().session).toMatchObject({
		outputLimit: 1024,
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
	h.state.steps.push({ text: "Bです。" });
	h.start();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
});
