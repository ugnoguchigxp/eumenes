import { afterEach, expect, test } from "bun:test";
import { toolFields } from "./tool-text.fixture";
import { hostDelivery } from "../../delivery";
import { IMAGE, INSTANT, setup, type Harness } from "./generation.fixture";

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
	// The system part, then the last message: the state of this call and the utterance itself.
	expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
	expect(call.messages[1]!.content).toStartWith("## State\n今: ");
	expect(call.messages[1]!.content).toEndWith("\n\n## User\nやあ");
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
	// Only the new utterance is the user's; the failed one was handled unanswered and is no longer asked again.
	const last = h.state.calls.at(-1)!.messages;
	expect(last.at(-1)!.content).toEndWith("## User\n今日は寒いね");
	expect(last.at(-1)!.content).not.toContain("こんばんは\n");
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
	const refused = toolFields(tool.at(-1)!.content);
	expect(refused.refused).toBe(true);
	expect(String(refused.issues)).toContain("reason confirmation_required");
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
		.map((m) => m.content);
	expect(tool).toHaveLength(3);
	expect(tool[0]).toStartWith(`- ${IMAGE.id}: `);
	expect(tool[1]).toStartWith(`- ${IMAGE.id}: `);
	expect(toolFields(tool[2]!)).toMatchObject({ refused: true });
});

test("refused calls do not use up the reply: the refusal names the missing field, and the reply's last call keeps the tools with no call allowed", async () => {
	h = await setup();
	// A call without its request: refused every time.
	const unannounced = {
		name: "delegate",
		args: { mode: "execute", toolchain: IMAGE.id, impact: "create" },
	};
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		...Array.from({ length: 5 }, () => ({ calls: [unannounced] })),
		{ text: "うまく頼めませんでした。" },
	);
	const run = await h.say("夜の絵を描いて");
	expect(h.dialogue.answerText(run.id)).toBe("うまく頼めませんでした。");
	// The search and five refusals are the reply's six calls; every call but the last offers them.
	expect(h.state.calls).toHaveLength(7);
	const all = ["memory", "find_toolchain", "delegate", "work"];
	for (const call of h.state.calls) expect(call.tools).toEqual(all);
	expect(h.state.calls.map((c) => c.session?.toolChoice ?? null)).toEqual([
		...Array.from({ length: 6 }, () => null),
		"none",
	]);
	const results = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")
		.map((m) => m.content);
	expect(results).toHaveLength(6);
	// A call written wrong is told which field is missing and what it may be; nothing of the log's issues.
	expect(toolFields(results[1]!)).toEqual({
		refused: true,
		reason: "invalid_tool_arguments",
		request: "required（expected string）",
	});
	expect(results[1]).not.toContain("validationPath");
	expect(results.at(-1)).toEndWith(
		"この返事ではもうツールを使えません。ここまでにわかっていることだけで返事をします。",
	);
	expect(results.slice(0, -1).join("\n")).not.toContain(
		"この返事ではもうツールを使えません",
	);
	// It asked a toolchain and nothing was accepted: the selection's output broke the contract.
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "rejected" });
});

test("a call that ends cleanly with nothing to say completes the run with no answer; a broken stream still fails it", async () => {
	h = await setup();
	h.state.steps.push({ fail: "chat_output_empty" });
	const silent = await h.say("いやあ、それはそうと、");
	expect(silent.status).toBe("completed");
	expect(h.dialogue.answerText(silent.id)).toBeFalsy();
	h.state.steps.push({ fail: "chat_stream_incomplete" });
	const broken = await h.say("続きです", "failed");
	expect(broken.error).toBe("chat_stream_incomplete");
});

test("a delegation without impact is taken at the toolchain's least impact; on a saved target it is confirmed first", async () => {
	h = await setup();
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
						target: "s1",
						announcement: "描きますね。",
					},
				},
			],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("描きますね。");
	// The first call named a saved target with no impact: taken as changing it, it needs a confirmation.
	const results = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")
		.map((m) => toolFields(m.content));
	expect(String(results[1]!.issues)).toContain("confirmation_required");
	expect(h.todos()).toHaveLength(1);
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
	expect(tool.at(-1)!.content).toBe(
		"- answered: true\n- answer: 東京は12時です。",
	);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("an instant toolchain needs no request text; any other toolchain is refused without it, naming the field", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "時刻と絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: INSTANT.id,
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
	const tool = h.state.calls.at(-1)!.messages.filter((m) => m.role === "tool");
	expect(tool.at(-2)!.content).toBe(
		"- refused: true\n- reason: invalid_tool_arguments\n- request: required（expected string）",
	);
	expect(tool.at(-1)!.content).toBe(
		"- answered: true\n- answer: 東京は12時です。",
	);
	expect(h.todos()).toEqual([]);
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
	expect(h.archived()).toMatchObject([{ status: "done" }]);
});

test("an answer delivery uses the emotion of the reply, never judged again", async () => {
	const emotion = "enjoyment" as const;
	h = await setup({
		conversationAgent: {
			system: () => ({ base: "", toolRules: "" }),
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
	expect(toolFields(refused!.content)).toMatchObject({ refused: true });
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
		h.state.calls[4]!.messages.at(-1)!
			.content.split("\n")
			.some((line) => line.startsWith("- c1 確認待ち ")),
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
