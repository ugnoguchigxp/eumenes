import { afterEach, expect, test } from "bun:test";
import { hostDelivery } from "../../delivery";
import {
	IMAGE,
	INSTANT,
	sectionLines,
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
	h.state.steps.push({ text: "こんにちは。" });
	const run = await h.say("やあ");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	expect(h.state.calls).toHaveLength(1);
	const call = h.state.calls[0]!;
	// System, the material document, `<now>` of this call, then the newest message (the utterance itself).
	expect(call.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
		"user",
		"user",
	]);
	expect(call.messages[3]!.content).toBe("やあ");
	expect(call.messages[2]!.content.startsWith("<now>\n")).toBe(true);
	expect(call.messages[1]!.content).toContain("<log>\n");
	// The fixed tools only: there is no `respond` to call, and a reply needs none.
	expect(call.tools).toEqual(["memory", "find_toolchain", "delegate", "work"]);
	const log = h.log();
	expect(log.map((e) => [e.type, e.by])).toEqual([
		["said", "user"],
		["said", "agent"],
		["delivered", "host"],
	]);
	expect(h.fields(log[2]!)).toMatchObject({ ref: log[1]!.id, heard: "full" });
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
	h.state.steps.push({ text: "こんばんは。" });
	const run = await h.say("今日は寒いね");
	expect(h.dialogue.answerText(run.id)).toBe("こんばんは。");
	// Only the new utterance is the newest message; the failed one is in the document.
	const last = h.state.calls.at(-1)!.messages;
	expect(last.at(-1)!.content).toBe("今日は寒いね");
	expect(last.filter((m) => m.content === "こんばんは")).toHaveLength(0);
});

test("text written beside a tool call is spoken before it and kept: the answer is the whole spoken text", async () => {
	h = await setup();
	h.state.steps.push(
		{
			text: "調べますね。",
			calls: [{ name: "find_toolchain", args: { query: "時刻" } }],
		},
		{ text: "見つかりませんでした。" },
	);
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe(
		"調べますね。見つかりませんでした。",
	);
	expect(h.state.calls).toHaveLength(2);
});

test("a refused tool call is returned as the tool's result, and the reply goes on", async () => {
	h = await setup();
	h.state.steps.push(
		// A change without its confirmation is refused, not executed.
		{
			calls: [{ name: "find_toolchain", args: { query: "絵の差替え" } }],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
						announcement: "差し替えます。",
					},
				},
			],
		},
		{ text: "先に確認させてください。差し替えてよいですか？" },
	);
	const run = await h.say("壁紙を差し替えて");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(
		"先に確認させてください。差し替えてよいですか？",
	);
	const tool = h.state.calls.at(-1)!.messages.filter((m) => m.role === "tool");
	const refused = JSON.parse(tool.at(-1)!.content) as {
		refused: boolean;
		issues: Array<{ reason?: string }>;
	};
	expect(refused.refused).toBe(true);
	expect(refused.issues.map((issue) => issue.reason)).toContain(
		"confirmation_required",
	);
	// Nothing was handed over.
	expect(h.todos()).toEqual([]);
	// The refusal is not an error of the run: no repair message, no failure.
	expect(
		h.state.calls
			.flatMap((call) => call.messages)
			.some((m) => m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT=")),
	).toBe(false);
});

test("a second search runs like the first, a call the host cannot read is refused with its reason, and the reply continues", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{ calls: [{ name: "find_toolchain", args: { query: "もう一度" } }] },
		{ calls: [{ name: "no_such_tool", args: {} }] },
		{ text: "お断りします。" },
	);
	const run = await h.say("絵を描いて");
	expect(h.dialogue.answerText(run.id)).toBe("お断りします。");
	const tool = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")
		.map((m) => JSON.parse(m.content) as Record<string, unknown>);
	expect(tool).toHaveLength(3);
	expect(tool[0]).toHaveProperty("candidates");
	expect(tool[1]).toHaveProperty("candidates");
	expect(tool[2]).toMatchObject({ refused: true });
});

test("an instant toolchain's answer comes back as the tool result, and makes no TODO", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "時刻" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: INSTANT.id,
						request: "東京の時刻",
						impact: "none",
						inputs: { city: "東京" },
					},
				},
			],
		},
		{ text: "東京は12時です。" },
	);
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.todos()).toEqual([]);
	const tool = h.state.calls.at(-1)!.messages.filter((m) => m.role === "tool");
	expect(JSON.parse(tool.at(-1)!.content)).toEqual({
		answered: true,
		answer: "東京は12時です。",
	});
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("a delegation is announced, opens a TODO and hands the run over; the finished work ends the run without a generation and opens the agent's opportunity", async () => {
	const notified: string[] = [];
	h = await setup({
		agency: {
			stateForContextInTransaction: () => [],
			workChangedInTransaction: (_db, conversationId) => {
				notified.push(conversationId);
			},
		},
	});
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵を描く" } }] },
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
	// The result: the TODO is done, its result is a line of the log; no model call is made for it, and the agent is told.
	const done = await h.finishImage(waiting.id, {
		state: "completed",
		title: "猫",
	});
	expect(done.status).toBe("completed");
	expect(h.dialogue.answerText(done.id)).toBeNull();
	expect(h.state.calls).toHaveLength(calls);
	expect(notified).toEqual(["main"]);
	expect(h.todos()[0]).toMatchObject({ status: "done", outcome: "succeeded" });
	expect(h.results()).toHaveLength(1);
	expect(JSON.stringify(h.results())).toContain("猫");
	// Reporting the result is the agent's job: nothing was said or archived by the host.
	expect(
		h.log().filter((e) => e.by === "agent" && e.type === "said"),
	).toHaveLength(1);
	expect(h.log().some((e) => h!.fields(e).action === "work.archived")).toBe(
		false,
	);
});

test("a finished TODO with no agency port ends its run without a generation too", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "犬の絵",
						impact: "create",
						announcement: "描きます。",
					},
				},
			],
		},
	);
	const waiting = await h.say("犬の絵", "queued");
	const calls = h.state.calls.length;
	const done = await h.finishImage(waiting.id, {
		state: "completed",
		title: "犬",
	});
	expect(done.status).toBe("completed");
	expect(h.state.calls).toHaveLength(calls);
	expect(h.todos()).toMatchObject([{ status: "done" }]);
});

test("an answer delivery uses the emotion of the reply, never judged again", async () => {
	const emotion = "enjoyment" as const;
	h = await setup({
		conversationAgent: {
			system: () => "",
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
	h.state.steps.push({ text: "よかったですね。" });
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
	// The feeling came with the reply: no judgment call follows the one model call.
	expect(h.state.calls).toHaveLength(1);
});

test("a change needs a confirmation first; the approval executes the saved request", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵の差替え" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
						announcement: "差し替えます。",
					},
				},
			],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
					},
				},
			],
		},
		{ text: "今の壁紙を差し替えてよいですか？" },
	);
	await h.say("壁紙を差し替えて");
	const refused = h.state.calls[2]!.messages.find(
		(m) => m.role === "tool" && m.content.includes("confirmation_required"),
	);
	expect(JSON.parse(refused!.content)).toMatchObject({ refused: true });
	h.state.steps.push({
		calls: [
			{
				name: "delegate",
				args: {
					mode: "approve",
					confirmation: "c1",
					announcement: "差し替えます。",
				},
			},
		],
	});
	const approved = await h.say("お願い", "queued");
	// The confirmation was issued in the earlier generation; the approving generation's document shows it in <state>
	// under the number the approval names.
	expect(
		sectionLines(h.state.calls[4]!.messages[1]!.content, "state").some((line) =>
			line.startsWith("c1 確認待ち "),
		),
	).toBe(true);
	expect(approved.announcement).toBe("差し替えます。");
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
		{
			calls: [
				{
					name: "memory",
					args: {
						operation: "request",
						kind: "remember",
						what: "辛い物が好き",
					},
				},
			],
		},
		{ text: "覚えておきます。" },
	);
	const run = await h.say("辛い物が好きって覚えて");
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
	h.state.steps.push({ text: "長い答えです。続きがあります。" });
	const run = await h.say("教えて");
	// A text reply is delivered in full at once; a later playback report adds nothing.
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, run.id, "partial", "長い答え"),
	);
	expect(h.log().filter((e) => e.type === "delivered")).toHaveLength(1);
});
