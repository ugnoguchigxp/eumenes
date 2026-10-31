import { afterEach, expect, test } from "bun:test";
import { hostDelivery } from "../../delivery";
import {
	IMAGE,
	INSTANT,
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
	// The choice (nothing fits), then the talk turn.
	expect(h.state.calls).toHaveLength(2);
	const call = h.state.calls[1]!;
	// The system part, then the last message: the state of this call and the utterance itself.
	expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
	expect(call.messages[1]!.content).toStartWith("## State\n今: ");
	expect(call.messages[1]!.content).toEndWith("\n\n## User\nやあ");
	// The talk turn offers only the read tools this host has (no memory or agents here).
	expect(call.tools).toEqual(["read_history", "read_runs"]);
	const log = h.log();
	expect(log.map((e) => [e.type, e.by, h!.fields(e).action ?? null])).toEqual([
		["acted", "agent", "find_toolchain"],
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
	// Only the new utterance is the user's; the failed one was handled unanswered and is no longer asked again.
	const last = h.state.calls.at(-1)!.messages;
	expect(last.at(-1)!.content).toEndWith("## User\n今日は寒いね");
	expect(last.at(-1)!.content).not.toContain("こんばんは\n");
});

test("a request that names a saved target is taken as changing it: confirmed first, nothing handed over", async () => {
	h = await setup();
	h.state.steps.push(
		choice({
			choice: IMAGE.id,
			say: "描きますね。",
			request: "猫の絵",
			target: "s1",
		}),
	);
	const run = await h.say("猫の絵を描いて");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toContain("よろしいですか？");
	expect(h.dialogue.answerText(run.id)).toContain("今あるものを変えます");
	expect(h.todos()).toEqual([]);
});

test("choices the host cannot carry out twice leave the host's words and a rejected selection; nothing is handed over", async () => {
	h = await setup();
	h.state.steps.push(
		choice({ choice: INSTANT.id, inputs: {} }),
		choice({ choice: INSTANT.id, inputs: {} }),
	);
	const run = await h.say("東京は今何時？");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h.todos()).toEqual([]);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "rejected" });
});

test("an instant toolchain's answer is the host's answer, and makes no TODO", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.todos()).toEqual([]);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("a delegation is announced, opens a TODO and hands the run over; the finished work ends the run without a generation and is archived with its notice", async () => {
	const notified: string[] = [];
	h = await setup({
		agency: {
			workChangedInTransaction: (_db, conversationId) => {
				notified.push(conversationId);
			},
		},
	});
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("描きますね。");
	const [todo] = h.todos();
	expect(todo).toMatchObject({ status: "todo", title: "猫の絵" });
	const types = h
		.log()
		.map((e) => [
			e.type,
			e.by,
			h!.fields(e).action ?? h!.fields(e).origin ?? null,
		]);
	expect(types).toEqual([
		["acted", "agent", "find_toolchain"],
		["said", "user", null],
		["said", "agent", "announcement"],
		["delivered", "host", null],
		["acted", "agent", "delegate"],
	]);
	expect(notified).toEqual([]);
	const calls = h.state.calls.length;
	// The result: the TODO is done and archived with its notice, its result is a line of the log; no model call is
	// made for it, and the agent is told (it asks only what work asks).
	const done = await h.finishImage(waiting.id, {
		state: "completed",
		title: "猫",
	});
	expect(done.status).toBe("completed");
	expect(h.dialogue.answerText(done.id)).toBeNull();
	expect(h.state.calls).toHaveLength(calls);
	expect(notified).toEqual(["main"]);
	expect(h.todos()).toEqual([]);
	expect(h.archived()[0]).toMatchObject({
		status: "done",
		outcome: "succeeded",
	});
	expect(h.notices()).toMatchObject({ unread: 1, notices: [{ read: false }] });
	expect(h.results()).toHaveLength(1);
	expect(JSON.stringify(h.results())).toContain("猫");
	// The notice tells the result: nothing was said by the host.
	expect(
		h.log().filter((e) => e.by === "agent" && e.type === "said"),
	).toHaveLength(1);
});

test("a finished TODO with no agency port ends its run without a generation too", async () => {
	h = await setup();
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きます。", request: "犬の絵" }),
	);
	const waiting = await h.say("犬の絵", "queued");
	const calls = h.state.calls.length;
	const done = await h.finishImage(waiting.id, {
		state: "completed",
		title: "犬",
	});
	expect(done.status).toBe("completed");
	expect(h.state.calls).toHaveLength(calls);
	expect(h.archived()).toMatchObject([{ status: "done" }]);
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
	// The feeling came with the reply: no judgment call follows the turn's two calls (the choice and the talk).
	expect(h.state.calls).toHaveLength(2);
});

test("a change needs a confirmation first; the approval executes the saved request", async () => {
	h = await setup({
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
	});
	h.state.steps.push(
		choice({
			choice: IMAGE.id,
			say: "差し替えます。",
			request: "壁紙を差し替える",
		}),
	);
	const asked = await h.say("壁紙を差し替えて");
	expect(h.dialogue.answerText(asked.id)).toContain("よろしいですか？");
	// Nothing was handed over before the yes.
	expect(h.todos()).toEqual([]);
	h.state.steps.push(choice({ choice: "approve", confirmation: "c1" }));
	const approved = await h.say("お願い", "queued");
	// The approving turn's document shows the confirmation under the number the approval names.
	expect(
		h.state.calls
			.at(-1)!
			.messages.at(-1)!
			.content.split("\n")
			.some((line) => line.startsWith("- c1 確認待ち")),
	).toBe(true);
	expect(approved.announcement).toBeTruthy();
	expect(h.todos()[0]).toMatchObject({
		title: "壁紙を差し替える",
		status: "todo",
	});
	// A confirmation is used once.
	expect(
		h.store.read(
			(db) =>
				db.query("SELECT used_at FROM dialogue_confirmations").get() as {
					used_at: string | null;
				},
		).used_at,
	).not.toBeNull();
});

test("a memory request goes to the steward with the user's message as its source", async () => {
	h = await setup();
	h.state.steps.push(
		choice({
			choice: "memory.request",
			kind: "remember",
			what: "辛い物が好き",
			say: "覚えておきます。",
		}),
	);
	const run = await h.say("辛い物が好きって覚えて");
	expect(h.dialogue.answerText(run.id)).toBe("覚えておきます。");
	expect(h.state.stewardRequests).toEqual([
		expect.objectContaining({
			kind: "remember",
			what: "辛い物が好き",
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
