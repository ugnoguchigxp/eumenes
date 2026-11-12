import { afterEach, expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import type { ConversationAgentPort } from "../contracts";
import { testConversationAgent } from "./conversation-agent.fixture";
import {
	IMAGE,
	INSTANT,
	choice,
	setup,
	type Call,
	type Harness,
} from "./generation.fixture";

/**
 * The talk turn's way to a toolchain (spec router-package-integration, 2026-11-12): when the router left the turn to
 * the conversation, a reply whose agent hands work over may look for a toolchain and hand the work to it; the host
 * carries the hand-over out as it does the router's.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** An agent whose reply hands work over (the agenda's, in the application). */
const handing: ConversationAgentPort = {
	...testConversationAgent,
	handsWork: () => true,
};

/** What the calls of a talk answered their tool calls with, in order. */
const toolResults = (call: Call) =>
	call.messages
		.filter((m) => (m.role as string) === "tool")
		.map((m) => JSON.parse(m.content) as Record<string, unknown>);

const find = (query: string) => ({
	calls: [{ name: "find_toolchain", args: { query } }],
});
const delegate = (toolchain: string, request: string) => ({
	calls: [
		{
			name: "delegate",
			args: { toolchain, request, mode: "execute", impact: "fixture" },
		},
	],
});

test("a reply that agreed to make something finds the toolchain and hands it the request it wrote: the host announces it", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		choice({ choice: "none" }),
		find("猫の絵を描く"),
		delegate(IMAGE.id, "夕暮れの猫の絵を描いてください"),
	);
	// The user's words alone name no work: the request is the reply's.
	const run = await h.say("はい、お願いします", "queued");
	expect(run.announcement).toBe("「画像」に頼みます。");
	const [talk, afterFind] = h.state.calls.slice(-2);
	expect(talk!.tools).toEqual([
		"read_history",
		"read_runs",
		"find_toolchain",
		"delegate",
	]);
	// It sees the toolchains only (the read tools are its own), by what they do; inputs are the host's to fill.
	expect(toolResults(afterFind!)).toEqual([
		{
			candidates: [
				{
					id: IMAGE.id,
					title: IMAGE.title,
					summary: IMAGE.summary,
					useWhen: IMAGE.useWhen,
				},
				{
					id: INSTANT.id,
					title: INSTANT.title,
					summary: INSTANT.summary,
					useWhen: INSTANT.useWhen,
				},
			],
		},
	]);
	// A search of the host's own, not the router's offer.
	expect(h.state.searchSlots.at(-1)).toBeUndefined();
	expect(h.todos().map((todo) => todo.title)).toEqual([
		"夕暮れの猫の絵を描いてください",
	]);
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		toolchainId: IMAGE.id,
		request: "夕暮れの猫の絵を描いてください",
	});
	// The router decided the conversation, and learns nothing from the reply's hand-over.
	expect(h.state.feedback).toHaveLength(0);
});

test("an instant toolchain the reply asked answers into the reply, which tells it in its own words", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		choice({ choice: "none" }),
		find("時刻を知る"),
		delegate(INSTANT.id, "東京の今の時刻"),
		// The host fills the inputs with the one-candidate call, as for the router's hand-over.
		choice({ choice: INSTANT.id, inputs: { city: "東京" } }),
		{ text: "東京はいま12時ですよ。" },
	);
	const run = await h.say("うん、教えて");
	expect(h.dialogue.answerText(run.id)).toBe("東京はいま12時ですよ。");
	expect(toolResults(h.state.calls.at(-1)!).at(-1)).toEqual({
		answered: true,
		answer: "東京は12時です。",
	});
});

test("a change of what exists is confirmed by the host first, and the user's yes in the next turn is the router's", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
	});
	h.state.steps.push(
		choice({ choice: "none" }),
		find("壁紙を差し替える"),
		// What the reply says before the tool is said first, and the host's statement follows on its own line.
		{
			text: "差し替えますね。",
			...delegate(IMAGE.id, "壁紙を夕暮れの猫に差し替える"),
		},
	);
	const asked = await h.say("お願い");
	expect(h.dialogue.answerText(asked.id)).toBe(
		"差し替えますね。\n画像に「壁紙を夕暮れの猫に差し替える」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(h.todos()).toHaveLength(0);
	h.state.steps.push(choice({ choice: "approve", confirmation: "c1" }));
	const approved = await h.say("はい", "queued");
	expect(approved.announcement).toBeTruthy();
	expect(h.todos()).toHaveLength(1);
});

test("delegate takes only a toolchain this reply found, and a reply that hands nothing over goes on talking", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		choice({ choice: "none" }),
		delegate(IMAGE.id, "猫の絵を描いてください"),
		{ text: "すみません、まだ頼めていません。" },
	);
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe(
		"すみません、まだ頼めていません。",
	);
	expect(toolResults(h.state.calls.at(-1)!)).toEqual([
		{ delegated: false, code: "unknown_toolchain" },
	]);
	expect(h.todos()).toHaveLength(0);
});

test("a pipeline is the router's to plan: the search does not show it, and it cannot be handed to", async () => {
	const pipeline: ToolchainCard = {
		...IMAGE,
		revisionId: "toolchain:fake.pipeline@1",
		id: "fake.pipeline",
		functionName: "fake_pipeline",
		title: "手順",
		execution: "pipeline",
	};
	h = await setup({ conversationAgent: handing, cards: [pipeline, IMAGE] });
	h.state.steps.push(
		choice({ choice: "none" }),
		find("曲と絵を順に作る"),
		delegate(pipeline.id, "曲を作ってから絵を描く"),
		{ text: "まとめては頼めませんでした。" },
	);
	await h.say("お願い");
	expect(toolResults(h.state.calls.at(-1)!)).toEqual([
		{
			candidates: [
				{
					id: IMAGE.id,
					title: IMAGE.title,
					summary: IMAGE.summary,
					useWhen: IMAGE.useWhen,
				},
			],
		},
		{ delegated: false, code: "unknown_toolchain" },
	]);
	expect(h.todos()).toHaveLength(0);
});

test("a question back keeps the request the reply wrote: the next turn's router reads the answer with it", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		choice({ choice: "none" }),
		find("時刻を知る"),
		delegate(INSTANT.id, "いまの時刻を教えてほしい"),
		choice({ choice: "ask", say: "どの都市の時刻ですか？" }),
	);
	const asked = await h.say("うん、お願い");
	expect(h.dialogue.answerText(asked.id)).toBe("どの都市の時刻ですか？");
	// The user's own words named no work; the answer goes to the router with what the reply asked for.
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const answered = await h.say("東京");
	expect(h.state.routerEmbeds.at(-1)).toBe("いまの時刻を教えてほしい\n東京");
	expect(h.dialogue.answerText(answered.id)).toBe("東京は12時です。");
});

test("a request the fill cannot read is not handed over: the reply is told and goes on", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		choice({ choice: "none" }),
		find("時刻を知る"),
		delegate(INSTANT.id, "なにか"),
		choice({ choice: "none" }),
		{ text: "どの都市か教えてもらえますか。" },
	);
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe("どの都市か教えてもらえますか。");
	expect(toolResults(h.state.calls.at(-1)!).at(-1)).toEqual({
		delegated: false,
		code: "request_unclear",
	});
});

test("an agent whose reply does not hand work over is offered neither tool, and a call of one is refused", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), find("猫の絵を描く"), {
		text: "いまは頼めません。",
	});
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe("いまは頼めません。");
	const [talk, answer] = h.state.calls.slice(-2);
	expect(talk!.tools).toEqual(["read_history", "read_runs"]);
	expect(
		answer!.messages.find((m) => (m.role as string) === "tool")?.content,
	).toContain("invalid_tool_call");
	// The router's own offer is the only search of the turn.
	expect(h.state.searchSlots.every((ids) => ids !== undefined)).toBe(true);
});
