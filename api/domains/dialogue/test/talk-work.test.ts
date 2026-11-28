import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import type { ToolchainCard } from "../../capabilities";
import type { AgencyLayerPort, ConversationAgentPort } from "../contracts";
import { byId } from "../repository";
import { delegate as delegateTool } from "../service/executor-delegation";
import type { ExecutorContext } from "../service/executor-context";
import { testConversationAgent } from "./conversation-agent.fixture";
import {
	IMAGE,
	INSTANT,
	agencyOf,
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
	calls: [{ name: "delegate", args: { toolchain, request } }],
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
});

test("a reply that agreed to make something finds the toolchain and hands it the request it wrote: it becomes the agent's assignment", async () => {
	const { agency, assigned } = agencyOf();
	h = await setup({ conversationAgent: handing, agency });
	h.state.steps.push(
		{ text: "夕暮れの猫の絵を描きましょうか？" },
		find("猫の絵を描く"),
		delegate(IMAGE.id, "夕暮れの猫の絵を描いてください"),
		{ text: "描いてもらいますね。" },
	);
	await h.say("夕暮れの猫、絵にしたらよさそう");
	const run = await h.say("はい、お願いします");
	// No announcement and no hand-over of the run: the reply goes on and tells it in its own words.
	expect(run.announcement ?? null).toBeNull();
	expect(h.dialogue.answerText(run.id)).toBe("描いてもらいますね。");
	const [talk, afterFind, afterDelegate] = h.state.calls.slice(-3);
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
	expect(toolResults(afterDelegate!).at(-1)).toMatchObject({
		delegated: true,
		assignment: "a1",
		assignee: IMAGE.title,
	});
	expect(assigned).toHaveLength(1);
	expect(assigned[0]).toMatchObject({
		toolchainId: IMAGE.id,
		revisionId: IMAGE.revisionId,
		title: IMAGE.title,
		request: "夕暮れの猫の絵を描いてください",
		references: [],
	});
	expect(assigned[0]!.source).toMatchObject({
		conversationId: "main",
		runId: run.id,
		messageId: run.inputMessageId,
		request: "はい、お願いします",
	});
	expect(h.state.searchSlots).toEqual([undefined]);
	expect(
		h.state.selections.find((s) => s.decision === "toolchain"),
	).toMatchObject({
		decision: "toolchain",
		toolchainId: IMAGE.id,
		request: "夕暮れの猫の絵を描いてください",
	});
});

test("a change of what exists is no longer confirmed: the request is the agent's assignment at once", async () => {
	const { agency, assigned } = agencyOf();
	h = await setup({
		conversationAgent: handing,
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
		agency,
	});
	h.state.steps.push(
		find("壁紙を差し替える"),
		delegate(IMAGE.id, "壁紙を夕暮れの猫に差し替える"),
		{ text: "差し替えを頼みました。" },
	);
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe("差し替えを頼みました。");
	expect(assigned.map((a) => a.request)).toEqual([
		"壁紙を夕暮れの猫に差し替える",
	]);
});

/**
 * The `delegate` call itself, outside a talk turn: the arguments a cloud agent's strict schema may carry (a saved
 * item, an instant's inputs, routed steps) reach the agent's assignment as its details.
 */
async function delegateDirect(
	agency: AgencyLayerPort,
	args: Parameters<typeof delegateTool>[2],
	card: ToolchainCard = { ...IMAGE, minImpact: "modify_existing" },
	adapterRef?: string,
) {
	const run = await h!.say("壁紙を変えてほしい");
	const store = h!.store;
	const x = {
		deps: {
			store,
			conversation: h!.conversation,
			continuity: h!.continuity,
			clock: () => new Date().toISOString(),
			agency,
			toolchains: {
				catalogInTransaction: () => [
					{
						id: card.id,
						revisionId: card.revisionId,
						runtime: {
							execution: card.execution,
							...(adapterRef ? { binding: { adapterRef } } : {}),
						},
					},
				],
				recordSelectionInTransaction: () => "selection",
			},
		},
		offered: new Map([[card.id, card]]),
		input: { conversationId: "main", offers: [] },
		state: { newlyOffered: new Set<string>(), search: null, exchange: [] },
		current: (db: Parameters<typeof byId>[0]) => byId(db, run.id)!,
		acted: () => ({}),
		actionKey: (target: string) => target,
	} as unknown as ExecutorContext;
	return {
		run,
		outcome: await delegateTool(
			x,
			{
				name: "delegate",
				call: { id: "c1", name: "delegate", arguments: JSON.stringify(args) },
				args,
			},
			args,
			new AbortController().signal,
		),
	};
}

test("a request naming a saved item (modify_existing) becomes an assignment with no confirmation", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push({ text: "承知しました。" });
	const { agency, assigned } = agencyOf();
	const { outcome, run } = await delegateDirect(agency, {
		toolchain: IMAGE.id,
		request: "壁紙を夕暮れの猫に差し替える",
		target: "wallpaper-1",
		resolveUnsaved: "discard",
	});
	expect(outcome.result).toMatchObject({
		delegated: true,
		assignment: "a1",
		assignee: IMAGE.title,
	});
	expect(outcome.end).toBeUndefined();
	expect(assigned).toHaveLength(1);
	expect(assigned[0]).toMatchObject({
		toolchainId: IMAGE.id,
		request: "壁紙を夕暮れの猫に差し替える",
		details: { target: "wallpaper-1", resolveUnsaved: "discard" },
	});
	expect(assigned[0]!.source.runId).toBe(run.id);
});

test("an assignment carries the binding's adapter for its screen to open; a toolchain without a binding carries none", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push({ text: "承知しました。" }, { text: "承知しました。" });
	const { agency, assigned } = agencyOf();
	const args = { toolchain: IMAGE.id, request: "夕暮れの猫の絵を描く" };
	await delegateDirect(agency, args, IMAGE, "adapter:fake.image@1");
	await delegateDirect(agency, args, IMAGE);
	expect(assigned.map((a) => a.adapterRef)).toEqual([
		"adapter:fake.image@1",
		undefined,
	]);
});

test("agency_unavailable: the agenda does not serve the conversation, so nothing is handed over", async () => {
	const { agency, assigned } = agencyOf(false);
	h = await setup({ conversationAgent: handing, agency });
	h.state.steps.push(
		find("猫の絵を描く"),
		delegate(IMAGE.id, "夕暮れの猫の絵を描いてください"),
		{ text: "いまは頼めません。" },
	);
	const run = await h.say("猫の絵を描いて");
	expect(h.dialogue.answerText(run.id)).toBe("いまは頼めません。");
	expect(toolResults(h.state.calls.at(-1)!).at(-1)).toEqual({
		delegated: false,
		code: `${IMAGE.title}: agency_unavailable`,
	});
	expect(assigned).toHaveLength(0);
	// The same through the delegate call alone.
	h.state.steps.push({ text: "はい。" });
	const direct = await delegateDirect(agencyOf(false).agency, {
		toolchain: IMAGE.id,
		request: "夕暮れの猫の絵を描いてください",
	});
	expect(direct.outcome.result).toEqual({
		delegated: false,
		code: "agency_unavailable",
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
});
