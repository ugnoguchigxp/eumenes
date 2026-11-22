import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
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
	configureLogging({ level: "silent" });
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
		"approve_confirmation",
		"decline_confirmation",
		"work",
		"discard_for_pending_switch",
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
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
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
	const stages = lines.filter(
		(entry) => entry.event === "performance.stage" && entry.runId === run.id,
	);
	expect(stages.map(({ phase, kind }) => [phase, kind])).toEqual([
		["generation_prepare", undefined],
		["generation_input_refresh", undefined],
		["query_embedding", "find_toolchain"],
		["tool_execution", "find_toolchain"],
		["tool_execution", "delegate"],
		["generation_respond", undefined],
		["generation_settle", undefined],
	]);
	for (const stage of stages) {
		expect(stage).toMatchObject({ outcome: "ok", jobId: run.jobId });
		expect(Number(stage.durationMs)).toBeGreaterThanOrEqual(0);
	}
	expect(JSON.stringify(stages)).not.toContain("時刻を知る");
	expect(JSON.stringify(stages)).not.toContain("東京はいま12時ですよ");
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

test("delegate takes only a toolchain actually offered to this conversation, and a reply that hands nothing over goes on talking", async () => {
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

test("the confirmation and work control tools stay byte-for-byte identical across plain talk, one confirmation, and two confirmations for KV cache stability", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
	});
	type Definition = {
		function: { name: string; parameters: Record<string, unknown> };
	};
	const allDefinitions = (calls: Call[]) =>
		(calls.findLast(({ tools }) => tools.includes("approve_confirmation"))
			?.toolDefinitions ?? []) as Definition[];
	h.state.steps.push({ text: "こんにちは。" });
	await h.say("こんにちは");
	const none = allDefinitions(h.state.calls);
	const first = "壁紙を夕暮れの猫に差し替える";
	h.state.steps.push(find("壁紙を差し替える"), delegate(IMAGE.id, first));
	await h.say("お願い");
	h.state.steps.push({ text: "確認待ちです。" });
	await h.say("今どうなってる？");
	const one = allDefinitions(h.state.calls);
	const second = "別の壁紙を青い海に差し替える";
	h.state.steps.push(find("壁紙を差し替える"), delegate(IMAGE.id, second));
	await h.say("もう一つお願い");
	h.state.steps.push({ text: "どちらも確認待ちです。" });
	await h.say("今どうなってる？");
	const two = allDefinitions(h.state.calls);
	// Every tool definition stays byte-for-byte identical across 0, 1, and 2 confirmations.
	expect(one).toEqual(none);
	expect(two).toEqual(none);
	const text = JSON.stringify(two);
	expect(text).not.toContain(first);
	expect(text).not.toContain(second);
	// The saved requests are told by `## State`, which the reply reads.
	const seen = h.state.calls
		.findLast(({ tools }) => tools.includes("approve_confirmation"))!
		.messages.map(({ content }) => content)
		.join("\n");
	expect(seen).toContain(`c1 確認待ち`);
	expect(seen).toContain(first);
	expect(seen).toContain(second);
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
	expect(await h.dialogue.clearRecent("main")).toBe(true);
	h.state.steps.push({
		calls: [
			{
				name: "delegate",
				args: { toolchain: newTool.id, request: corrected, revises: "c1" },
			},
		],
	});
	const asked = await h.say(
		"担当は編集担当に変えて、既存設定の範囲だけでお願いします",
	);
	expect(h.state.searchSlots).toHaveLength(1);
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain(newTool.id);
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

test("a correction waiting for more detail survives a cut, while cancelling its draft leaves nothing to approve", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }],
	});
	const original = "登録済みの作業場所で表示設定を保存する";
	h.state.steps.push(find(original), delegate(IMAGE.id, original));
	await h.say(original);
	h.state.steps.push(
		{
			calls: [
				{
					name: "decline_confirmation",
					args: { confirmation: "c1", followUp: "revise" },
				},
			],
		},
		{ text: "表示方法の指定を待ちます。" },
	);
	await h.say("保存はそのまま。表示方法を変えたい");
	h.state.steps.push(
		{
			calls: [
				{
					name: "decline_confirmation",
					args: { confirmation: "c1", followUp: "revise" },
				},
			],
		},
		{ text: "端末の範囲も引き継ぎます。" },
	);
	await h.say("対象は今使っている端末だけです。配色はあとで決めます");
	await h.dialogue.clearRecent("main");
	h.state.steps.push(
		{
			calls: [
				{
					name: "decline_confirmation",
					args: { confirmation: "c1", followUp: "cancel" },
				},
			],
		},
		{ text: "取り消しました。" },
	);
	await h.say("この依頼を取り消して");
	const correction = h.state.calls.at(-2)!;
	expect(correction.messages.at(-1)!.content).toContain(original);
	expect(correction.messages.at(-1)!.content).toContain("保存はそのまま");
	expect(correction.messages.at(-1)!.content).toContain(
		"対象は今使っている端末だけ",
	);
	// `approve_confirmation` stays statically offered in KV cache, and approving a closed/revising ref is refused by the host.
	expect(correction.tools).toContain("approve_confirmation");
	h.state.steps.push(confirm("approve_confirmation", "c1"), {
		text: "承認できる確認はありません。",
	});
	await h.say("これで承認");
	expect(toolResults(h.state.calls.at(-1)!)).toContainEqual({
		ok: false,
		code: "unknown_confirmation",
	});
	h.state.steps.push({ text: "受付済みの作業はありません。" });
	await h.say("いまの状態は？");
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).not.toContain(
		"訂正中の依頼",
	);
	expect(h.state.searchSlots).toHaveLength(1);
	expect(h.todos()).toHaveLength(0);
});

test("a previously shown list is usable without prior dispatch, but its corrected source and unavailable revision grant nothing", async () => {
	const unavailable: string[] = [];
	h = await setup({ conversationAgent: handing, unbuildable: unavailable });
	h.state.steps.push(find("表示を描いて時刻も確かめる"), {
		text: "候補を確認しました。",
	});
	const source = await h.say("どの担当が使える？");
	await h.dialogue.clearRecent("main");
	unavailable.push(IMAGE.revisionId);
	h.state.steps.push(delegate(IMAGE.id, "背景を描く"), {
		text: "その担当は使えません。",
	});
	await h.say("画像の担当で");
	expect(toolResults(h.state.calls.at(-1)!)).toContainEqual({
		delegated: false,
		code: "unknown_toolchain",
	});
	expect(h.state.calls.at(-2)!.messages.at(-1)!.content).toContain(INSTANT.id);
	unavailable.length = 0;
	await h.store.write((db) =>
		h!.conversation.correctInTransaction(db, {
			messageId: source.inputMessageId,
			text: "この検索は別件でした",
		}),
	);
	h.state.steps.push(delegate(IMAGE.id, "背景を描く"), {
		text: "候補を改めて確認します。",
	});
	await h.say("さっきの担当で");
	expect(toolResults(h.state.calls.at(-1)!)).toContainEqual({
		delegated: false,
		code: "unknown_toolchain",
	});
	expect(h.state.searchSlots).toHaveLength(1);
	expect(h.todos()).toHaveLength(0);
});

test("one persistent search per conversation: a new list replaces all old candidates, even within the turn or when it is empty", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [IMAGE, INSTANT],
		searches: [[IMAGE.id], [INSTANT.id], []],
	});
	h.state.steps.push(find("背景画像を作る"), {
		text: "画像の担当が見つかりました。",
	});
	await h.say("背景画像の担当を探して");
	h.state.offsetMs += 24 * 60 * 60 * 1000;
	await h.dialogue.clearRecent("main");
	h.state.steps.push(
		find("時刻だけ確認する"),
		delegate(IMAGE.id, "背景画像を描く"),
		{ text: "時計の担当だけが候補です。" },
	);
	await h.say("別件です。時計の担当だけ探して");
	expect(h.state.calls.at(-3)!.messages.at(-1)!.content).toContain(IMAGE.id);
	expect(toolResults(h.state.calls.at(-1)!)).toContainEqual({
		delegated: false,
		code: "unknown_toolchain",
	});
	await h.dialogue.clearRecent("main");
	h.state.steps.push(find("ほかの担当を探す"), {
		text: "該当する候補はありません。",
	});
	await h.say("ほかの担当も探して");
	const beforeEmpty = h.state.calls.at(-2)!.messages.at(-1)!.content;
	expect(beforeEmpty).toContain(INSTANT.id);
	expect(beforeEmpty).not.toContain(IMAGE.id);
	h.state.steps.push(delegate(INSTANT.id, "今の時刻を確認する"), {
		text: "候補がありません。",
	});
	await h.say("最後に挙がった候補で");
	const current = h.state.calls.at(-2)!.messages.at(-1)!.content;
	expect(current).not.toContain("検索済みの担当候補");
	expect(toolResults(h.state.calls.at(-1)!)).toContainEqual({
		delegated: false,
		code: "unknown_toolchain",
	});
	expect(h.state.searchSlots).toHaveLength(3);
	const slots = h.store.read((db) =>
		db
			.query<{ search_json: string }, []>(
				"SELECT search_json FROM dialogue_search_offers",
			)
			.all(),
	);
	expect(slots).toHaveLength(1);
	expect(JSON.parse(slots[0]!.search_json).candidates).toEqual([]);
	expect(h.todos()).toHaveLength(0);
});

test("two searches in one reply keep the last list while a previously presented confirmation still executes exactly once", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
		searches: [[IMAGE.id], [INSTANT.id], []],
	});
	h.state.steps.push(
		find("壁紙の変更"),
		delegate(IMAGE.id, "壁紙の配色を変更する"),
	);
	await h.say("壁紙の配色を変更して");
	h.state.steps.push(find("時刻の担当"), find("別地域の担当"), {
		text: "最後の検索は0件でした。",
	});
	await h.say("時計の担当と、そのあと別地域の担当を探して");
	await h.dialogue.clearRecent("main");
	h.state.steps.push(confirm("approve_confirmation", "c1"));
	await h.say("先ほどの壁紙の変更を承認します", "queued");
	const input = h.state.calls.at(-1)!.messages.at(-1)!.content;
	expect(input).not.toContain("検索済みの担当候補");
	expect(h.todos()).toHaveLength(1);
	expect(h.state.searchSlots).toHaveLength(3);
});

test("a text-only reply to a pending confirmation can revise and accept in that turn; an ordinary reply remains speech", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }],
	});
	const request = "背景を選べるようにする";
	const corrected = "背景を選び、再起動後も反映する";
	h.state.steps.push(find(request), delegate(IMAGE.id, request));
	await h.say(request);
	h.state.steps.push({ text: "配色についてのご相談ですね。" });
	h.state.confirmationDecisions.push({ choice: "reply" });
	const offTopic = await h.say("別件で配色の相談があります");
	expect(h.dialogue.answerText(offTopic.id)).toBe(
		"配色についてのご相談ですね。",
	);
	expect(h.todos()).toHaveLength(0);
	await h.dialogue.clearRecent("main");
	h.state.steps.push({ text: "訂正を反映できませんでした。" });
	h.state.confirmationDecisions.push({
		choice: "revise",
		confirmation: "c1",
		toolchain: IMAGE.id,
		request: corrected,
	});
	const revised = await h.say("再起動した後にも色を反映して");
	expect(h.dialogue.answerText(revised.id)).toContain(corrected);
	expect(h.dialogue.answerText(revised.id)).not.toContain("反映できません");
	expect(h.todos()).toHaveLength(0);
	h.state.steps.push({ text: "同じ内容をもう一度ご確認ください。" });
	h.state.confirmationDecisions.push({ choice: "approve", confirmation: "c2" });
	const approved = await h.say("この内容でお願いします", "queued");
	expect(approved.announcement).not.toContain("もう一度");
	const decisions = h.state.calls
		.filter(
			(c) =>
				c.session?.outputSchema &&
				c.messages.at(-1)?.content.startsWith('{"lastReply":'),
		)
		.map((c) => JSON.parse(c.messages.at(-1)!.content).lastReply.confirmation);
	expect(decisions).toEqual(["c1", null, "c2"]);
	expect(h.todos()).toHaveLength(1);
	expect(h.state.searchSlots).toHaveLength(1);
});

test("a rejected empty correction keeps its chosen reference when the reply retries with the full request", async () => {
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }],
	});
	h.state.steps.push(
		find("背景色を変える"),
		delegate(IMAGE.id, "背景色を変える"),
	);
	await h.say("背景色を変えて");
	h.state.steps.push(
		{
			calls: [
				{
					name: "delegate",
					args: { toolchain: IMAGE.id, request: "", revises: "c1" },
				},
			],
		},
		delegate(IMAGE.id, "背景色を保存して次回にも反映する"),
	);
	const revised = await h.say("次回にも色を反映して");
	expect(h.dialogue.answerText(revised.id)).toContain("次回にも反映");
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT c.ref, c.superseded_at IS NOT NULL as closed, p.ref as previous FROM dialogue_confirmations c LEFT JOIN dialogue_confirmations p ON p.id=c.revises_id ORDER BY c.ref",
				)
				.all(),
		),
	).toEqual([
		{ ref: 1, closed: 1, previous: null },
		{ ref: 2, closed: 0, previous: 1 },
	]);
	expect(h.state.searchSlots).toHaveLength(1);
});
