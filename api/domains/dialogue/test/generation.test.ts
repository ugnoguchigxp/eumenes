import { afterEach, expect, test } from "bun:test";
import { hostDelivery } from "../../delivery";
import {
	IMAGE,
	INSTANT,
	agencyOf,
	choice,
	reply,
	setup,
	type Harness,
} from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("an utterance is answered with plain text: the said events, a full delivery and the answer trace", async () => {
	h = await setup();
	h.state.steps.push(...reply("こんにちは。"));
	const run = await h.say("やあ");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	// The router finds nothing to hand over: the talk turn is the only call.
	expect(h.state.calls).toHaveLength(1);
	const call = h.state.calls[0]!;
	// The system part, then the last message: the state of this call and the utterance itself.
	expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
	expect(call.messages[1]!.content).toStartWith("## State\n今: ");
	expect(call.messages[1]!.content).toEndWith("\n\n## User\nやあ");
	// The talk turn offers static read, memory, and work tools (no memory/agents read tools in this fixture).
	expect(call.tools).toEqual([
		"read_history",
		"read_runs",
		"memory",
		"find_toolchain",
		"delegate",
		"discard_for_pending_switch",
	]);
	const log = h.log();
	expect(log.map((e) => [e.type, e.by, h!.fields(e).action ?? null])).toEqual([
		["said", "user", null],
		["said", "agent", null],
		["delivered", "host", null],
	]);
	const said = log.find((e) => e.type === "said" && e.by === "agent")!;
	const delivered = log.find((e) => e.type === "delivered")!;
	expect(h.fields(delivered)).toMatchObject({ ref: said.id, heard: "full" });
	const selection = h.state.selections.at(-1)!;
	expect(selection).toMatchObject({ decision: "answer" });
	expect(selection).not.toHaveProperty("analysis");
	expect(selection).not.toHaveProperty("repaired");
});

test("a model call that fails fails the run; its utterance joins the log unanswered and the next generation answers only its own", async () => {
	h = await setup();
	// No scripted step: the model call fails.
	await h.say("こんばんは", "failed");
	expect(h.log().map((e) => h!.fields(e).text)).toContain("こんばんは");
	h.state.steps.push(...reply("こんばんは。"));
	const run = await h.say("今日は寒いね");
	expect(h.dialogue.answerText(run.id)).toBe("こんばんは。");
	// The failed turn remains in history and only the new utterance is the current request.
	const last = h.state.calls.at(-1)!.messages;
	expect(last.at(-1)!.content).toEndWith("## User\n今日は寒いね");
	expect(last.at(-1)!.content).toContain(
		"## Earlier\n\nこんばんは\n\n## State",
	);
	expect(h.state.searchSlots).toHaveLength(0);
});

test("invalid instant arguments leave a rejected selection without handing work over", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "東京の時刻" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: { toolchain: INSTANT.id, request: "東京の時刻" },
				},
			],
		},
		choice({ choice: INSTANT.id, inputs: {} }),
		{ text: "うまく頼めませんでした。もう一度言ってもらえますか。" },
	);
	const run = await h.say("東京は今何時？");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "rejected" });
});

test("an instant toolchain's answer is the host's answer, and hands nothing to the agent", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("a delegation is the agent's assignment: no announcement, the run goes on and completes with the reply", async () => {
	const { agency, assigned } = agencyOf();
	h = await setup({ agency });
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
		{ text: "猫の絵を頼みました。" },
	);
	const run = await h.say("猫の絵を描いて");
	expect(run.announcement ?? null).toBeNull();
	expect(h.dialogue.answerText(run.id)).toBe("猫の絵を頼みました。");
	// The run's selection record keeps the hand-over: the settled trace is no "answer" without a toolchain.
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		toolchainId: IMAGE.id,
		request: "猫の絵",
	});
	// The work keeps the request the conversation agent wrote, and the user's words it came from.
	expect(assigned).toHaveLength(1);
	expect(assigned[0]).toMatchObject({
		toolchainId: IMAGE.id,
		request: "猫の絵",
		source: { runId: run.id, request: "猫の絵を描いて" },
	});
	const types = h
		.log()
		.map((e) => [
			e.type,
			e.by,
			h!.fields(e).action ?? h!.fields(e).origin ?? null,
		]);
	expect(types).toEqual([
		["acted", "agent", "find_toolchain"],
		["acted", "agent", "delegate"],
		["said", "user", null],
		["said", "agent", null],
		["delivered", "host", null],
	]);
	expect(
		h
			.log()
			.map((e) => h!.fields(e))
			.find((fields) => fields.action === "delegate"),
	).toMatchObject({ toolchain: IMAGE.id, assignment: "a1" });
});

test("an answer delivery uses the emotion of the reply, never judged again", async () => {
	const emotion = "enjoyment" as const;
	h = await setup({
		conversationAgent: {
			system: () => ({ base: "" }),
			async respond(input) {
				const reply = await input.chat.complete(
					{ messages: input.messages, tools: [] },
					input.onDelta,
					input.signal,
				);
				return { text: reply.text, emotion, ended: false };
			},
		},
	});
	h.state.steps.push(...reply("よかったですね。"));
	const run = await h.say("テストに受かった");
	expect(h.dialogue.answerText(run.id)).toBe("よかったですね。");
	expect(h.conversation.get("main").messages.at(-1)).toMatchObject({
		text: "よかったですね。",
		delivery: {
			version: 2,
			emotion,
			source: "host",
			motion: hostDelivery(emotion).motion,
			tone: hostDelivery(emotion).tone,
		},
	});
	// The feeling came with the reply: no judgment call follows the turn's talk call.
	expect(h.state.calls).toHaveLength(1);
});

test("a goal request goes to the steward with the user's message as its source", async () => {
	h = await setup();
	h.state.steps.push(
		choice({
			choice: "memory.request",
			kind: "goal",
			what: "毎朝ストレッチを続ける",
			say: "覚えておきます。",
		}),
	);
	const run = await h.say("毎朝ストレッチを続けたい");
	expect(h.dialogue.answerText(run.id)).toBe("覚えておきます。");
	expect(h.state.stewardRequests).toEqual([
		expect.objectContaining({
			kind: "goal",
			what: "毎朝ストレッチを続ける",
			sourceRef: run.inputMessageId,
		}),
	]);
});

test("a spoken answer cut short records what was heard, without the announcement", async () => {
	h = await setup();
	h.state.steps.push(...reply("長い答えです。続きがあります。"));
	const run = await h.say("教えて");
	// A text reply is delivered in full at once; a later playback report adds nothing.
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, run.id, "partial", "長い答え"),
	);
	expect(h.log().filter((e) => e.type === "delivered")).toHaveLength(1);
});
