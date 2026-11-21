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

const confirm = (
	name: "approve_confirmation" | "decline_confirmation",
	confirmation: string,
) => ({
	calls: [{ name, args: { confirmation } }],
});

test("conversation and discussion do not start a toolchain search", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push({
		text: "変更するなら、操作が一か所にあると見つけやすいです。",
	});
	const run = await h.say("表示の切替を付けるとしたら、どんな操作がよさそう？");
	expect(h.dialogue.answerText(run.id)).toContain("見つけやすい");
	expect(h.state.calls).toHaveLength(1);
	expect(h.state.calls[0]!.messages[0]!.content).toContain(
		"今実行を頼まれていることを見極めます",
	);
	expect(h.state.searchSlots).toHaveLength(0);
	expect(h.todos()).toHaveLength(0);
});

test("a reply that agreed to make something finds the toolchain and hands it the request it wrote: the host announces it", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		find("猫の絵を描く"),
		delegate(IMAGE.id, "夕暮れの猫の絵を描いてください"),
	);
	// The user's words alone name no work: the request is the reply's.
	h.state.steps.unshift({ text: "夕暮れの猫の絵を描きましょうか？" });
	await h.say("夕暮れの猫、絵にしたらよさそう");
	const run = await h.say("はい、お願いします", "queued");
	expect(run.announcement).toBe("「画像」に頼みます。");
	const [talk, afterFind] = h.state.calls.slice(-2);
	expect(
		talk!.messages.some(({ content }) =>
			content.includes("夕暮れの猫の絵を描きましょうか"),
		),
	).toBe(true);
	expect(talk!.tools).toEqual([
		"read_history",
		"read_runs",
		"memory",
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
					execution: IMAGE.execution,
				},
				{
					id: INSTANT.id,
					title: INSTANT.title,
					summary: INSTANT.summary,
					useWhen: INSTANT.useWhen,
					execution: INSTANT.execution,
				},
			],
		},
	]);
	expect(h.state.searchSlots).toEqual([undefined]);
	expect(h.todos().map((todo) => todo.title)).toEqual([
		"夕暮れの猫の絵を描いてください",
	]);
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		toolchainId: IMAGE.id,
		request: "夕暮れの猫の絵を描いてください",
	});
});

test("an instant toolchain the reply asked answers into the reply, which tells it in its own words", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
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

test("a change of what exists waits for approval of the saved request in a later turn", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
	});
	h.state.steps.push(
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
	h.state.steps.push(confirm("approve_confirmation", "c1"));
	const approved = await h.say("はい", "queued");
	expect(approved.announcement).toBeTruthy();
	expect(h.todos()).toHaveLength(1);
});

test("delegate takes only a toolchain this reply found, and a reply that hands nothing over goes on talking", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(delegate(IMAGE.id, "猫の絵を描いてください"), {
		text: "すみません、まだ頼めていません。",
	});
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe(
		"すみません、まだ頼めていません。",
	);
	expect(toolResults(h.state.calls.at(-1)!)).toEqual([
		{ delegated: false, code: "unknown_toolchain" },
	]);
	expect(h.todos()).toHaveLength(0);
});

test("the existing pipeline is among the candidates for the whole request", async () => {
	const pipeline: ToolchainCard = {
		...IMAGE,
		revisionId: "toolchain:fake.pipeline@1",
		id: "fake.pipeline",
		functionName: "fake_pipeline",
		title: "手順",
		execution: "pipeline",
	};
	h = await setup({ conversationAgent: handing, cards: [pipeline, IMAGE] });
	h.state.steps.push(find("曲を作ってその曲に合う絵を描く"), {
		text: "パイプラインが候補にあります。",
	});
	await h.say("曲を作って、その曲に合う絵も描いてください");
	expect(toolResults(h.state.calls.at(-1)!)[0]).toMatchObject({
		candidates: [{ id: pipeline.id, execution: "pipeline" }, { id: IMAGE.id }],
	});
});

test("a question back exposes the request it was about to the next conversation turn", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
		find("時刻を知る"),
		delegate(INSTANT.id, "いまの時刻を教えてほしい"),
		choice({ choice: "ask", say: "どの都市の時刻ですか？" }),
	);
	const asked = await h.say("うん、お願い");
	expect(h.dialogue.answerText(asked.id)).toBe("どの都市の時刻ですか？");
	const next = h.state.calls.length;
	h.state.steps.push(
		find("東京の現在時刻を知る"),
		delegate(INSTANT.id, "東京の現在時刻を教えてください"),
		choice({ choice: INSTANT.id, inputs: { city: "東京" } }),
		{ text: "東京は12時です。" },
	);
	const answered = await h.say("東京");
	expect(h.state.calls[next]!.messages.at(-1)!.content).toContain(
		"直前の質問が確認している依頼",
	);
	expect(h.state.calls[next]!.messages.at(-1)!.content).toContain(
		"いまの時刻を教えてほしい",
	);
	expect(h.dialogue.answerText(answered.id)).toBe("東京は12時です。");
});

test("a request the fill cannot read is not handed over: the reply is told and goes on", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push(
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
	h = await setup({
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
	});
	h.state.steps.push(find("猫の絵を描く"), {
		text: "いまは頼めません。",
	});
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe("いまは頼めません。");
	const [talk, answer] = h.state.calls.slice(-2);
	expect(talk!.tools).toEqual(["read_history", "read_runs", "memory"]);
	expect(
		answer!.messages.find((m) => (m.role as string) === "tool")?.content,
	).toContain("invalid_tool_call");
	expect(h.state.searchSlots).toHaveLength(0);
});

test("the conversation can look up current information and read the cited evidence before replying", async () => {
	const seen: string[] = [];
	h = await setup({
		async lookup(query, signal) {
			signal.throwIfAborted();
			seen.push(query);
			return {
				text: "東京地方は雨です。",
				sources: [{ url: "https://www.jma.go.jp/", title: "気象庁" }],
			};
		},
	});
	h.state.steps.push(
		{
			calls: [
				{
					name: "lookup_public_information",
					args: { query: "東京地方の11月15日の予報" },
				},
			],
		},
		{ text: "11月15日の東京地方は雨です。[別サイト](https://example.org/)" },
	);
	const run = await h.say("11月15日の東京の天気は？");
	expect(seen).toEqual(["東京地方の11月15日の予報"]);
	expect(toolResults(h.state.calls.at(-1)!)).toEqual([
		{
			text: "東京地方は雨です。",
			sources: [{ url: "https://www.jma.go.jp/", title: "気象庁" }],
		},
	]);
	expect(h.dialogue.answerText(run.id)).toContain("https://www.jma.go.jp/");
	expect(h.dialogue.answerText(run.id)).not.toContain("https://example.org/");
	expect(h.todos()).toHaveLength(0);
});

test("a correction closes the old confirmation and carries forward the work to a new one", async () => {
	const old = { ...IMAGE, minImpact: "modify_existing" as const };
	const newTool = {
		...old,
		id: "fake.other",
		revisionId: "toolchain:fake.other@1",
		functionName: "fake_other",
		title: "編集担当",
	};
	h = await setup({ conversationAgent: handing, cards: [old, newTool] });
	const initial = "制作画面の背景を切り替える機能を実装する";
	h.state.steps.push(find(initial), delegate(old.id, initial));
	await h.say(initial);
	expect(h.todos()).toHaveLength(0);
	const corrected =
		"制作画面の背景を切り替える機能を既存設定の範囲内で実装する";
	h.state.steps.push(
		confirm("decline_confirmation", "c1"),
		find(corrected + "。担当は編集担当"),
		delegate(newTool.id, corrected),
	);
	const asked = await h.say(
		"担当は編集担当に変えて、既存設定の範囲だけでお願いします",
	);
	expect(h.dialogue.answerText(asked.id)).toContain(
		`編集担当に「${corrected}」`,
	);
	expect(h.todos()).toHaveLength(0);

	h.state.steps.push(confirm("approve_confirmation", "c1"), {
		text: "その確認は終了しています。",
	});
	await h.say("前の確認を承認できる？");
	expect(h.todos()).toHaveLength(0);

	h.state.steps.push(confirm("approve_confirmation", "c2"));
	await h.say("編集担当にその内容でお願いします", "queued");
	expect(h.todos()).toHaveLength(1);
	expect(h.state.selections.at(-1)).toMatchObject({
		toolchainId: newTool.id,
		request: corrected,
	});

	h.state.steps.push(confirm("approve_confirmation", "c2"), {
		text: "すでに受け付けています。",
	});
	await h.say("もう一度承認");
	expect(h.todos()).toHaveLength(1);
});
