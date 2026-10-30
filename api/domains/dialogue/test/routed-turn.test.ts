import { afterEach, expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import { IMAGE, INSTANT, setup, type Harness } from "./generation.fixture";

/**
 * The local harness's routed turn (the local harness rebuild plan, section 4): with no judge, the request turn runs
 * first; the host searches with the user's words and the model makes one silent choice held to a schema built from
 * the candidates; the host carries it out and says its own words, or the talk turn answers.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** A routed turn's choice, as the model answers it. */
const choice = (value: Record<string, unknown>) => ({
	text: JSON.stringify(value),
});
/** The choices a schema offers, by their `choice` value. */
const offered = (schema: unknown) =>
	(
		schema as {
			anyOf: Array<{ properties: { choice: { enum: string[] } } }>;
		}
	).anyOf.flatMap((branch) => branch.properties.choice.enum);
const assistantTexts = () =>
	h!.conversation
		.get("main")
		.messages.filter((m) => m.role === "assistant")
		.map((m) => m.text);

test("an instant toolchain answers from the inputs the one choice gave: the host says its answer", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.calls).toHaveLength(1);
	const [chose] = h.state.calls;
	expect(chose!.tools).toEqual([]);
	expect(offered(chose!.session?.outputSchema)).toEqual([
		"none",
		"ask",
		IMAGE.id,
		INSTANT.id,
		"memory.recall",
		"memory.request",
	]);
	const input = chose!.messages.at(-1)!.content;
	expect(input).toContain("## State\n今: ");
	expect(input).toContain("## Candidates\n");
	expect(input).toContain(`- ${INSTANT.id}: `);
	expect(input).toContain("- memory.request: ");
	expect(input).toEndWith("## User\n東京は今何時？");
	expect(chose!.messages[0]!.content).toContain(
		"「## Candidates」のどれに、どう頼むかを一つ決めます",
	);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("long words are searched by their head: the search's bound does not leave the choice without candidates", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say(`東京は今何時？${"背景の説明です。".repeat(400)}`);
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.calls[0]!.messages.at(-1)!.content).toContain(
		`- ${INSTANT.id}: `,
	);
});

test("a choice the host cannot carry out is made once more with the reason, and a second failure gets the host's words", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(
		choice({ choice: INSTANT.id, inputs: {} }),
		choice({ choice: INSTANT.id, inputs: { city: "東京" } }),
	);
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.calls[1]!.messages.at(-1)!.content).toContain(
		"## Retry\n前の選び方では頼めませんでした（",
	);
	h.state.steps.push(
		choice({ choice: INSTANT.id, inputs: {} }),
		choice({ choice: INSTANT.id, inputs: {} }),
	);
	const again = await h.say("東京は？");
	expect(h.dialogue.answerText(again.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h.state.calls).toHaveLength(4);
});

test("an answer that is no choice is not made again: the talk turn answers", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push({ text: "choose" }, { text: "はい。" });
	const run = await h.say("こんにちは");
	expect(h.dialogue.answerText(run.id)).toBe("はい。");
	expect(h.state.calls).toHaveLength(2);
	expect(h.state.calls[1]!.session?.outputSchema).toBeUndefined();
});

test("a choice cut at the output limit is not made again: the talk turn answers; a failed talk gets the host's words", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(
		{ fail: "chat_stream_incomplete" },
		{ text: "決めきれませんでした。" },
		// The old path spends the second reply on another choice; let it finish so the call count fails explicitly.
		{ text: "決めきれませんでした。" },
	);
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("決めきれませんでした。");
	expect(h.state.calls).toHaveLength(2);
	expect(
		h.state.calls.filter((call) => call.session?.outputSchema),
	).toHaveLength(1);
	expect(h.state.calls[1]!.session?.outputSchema).toBeUndefined();
	expect(h.state.calls[1]!.messages.at(-1)!.content).not.toContain("## Retry");
	h.state.steps.length = 0;
	h.state.steps.push(choice({ choice: "none" }), {
		fail: "chat_stream_incomplete",
	});
	const failed = await h.say("こんにちは");
	expect(failed.status).toBe("completed");
	expect(h.dialogue.answerText(failed.id)).toBe(
		"うまく答えられませんでした。もう一度言ってもらえますか。",
	);
});

test("a talk that tells the user who spoke nothing gets the host's words; each call of the turn ends only itself", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: "none" }), { fail: "chat_output_empty" });
	const run = await h.say("こんにちは");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(
		"うまく答えられませんでした。もう一度言ってもらえますか。",
	);
	expect(h.state.calls.map((call) => call.session?.retainRequest)).toEqual([
		true,
		true,
	]);
});

test("a pipeline is handed the user's words as its request: its branch has inputs and no request of its own", async () => {
	const pipeline: ToolchainCard = {
		...IMAGE,
		revisionId: "toolchain:fake.pipeline@1",
		id: "fake.pipeline",
		functionName: "fake_pipeline",
		title: "手順",
		execution: "pipeline",
		pipeline: {
			parameters: {
				type: "object",
				properties: { topic: { type: "string" } },
				required: ["topic"],
			},
			outline: "調べる→曲",
			parse: (args) => ({ ok: true, value: args }),
		},
	};
	h = await setup({ harness: "local", cards: [pipeline, INSTANT] });
	h.state.steps.push(
		choice({ choice: pipeline.id, say: "進めます。", inputs: { topic: "雨" } }),
		choice({ choice: "none" }),
		{ text: "はい。" },
	);
	await h.say("雨の曲の手順を進めて");
	// The hand-over went past the argument check (this fixture runs no pipelines): the retry names the dispatch.
	const retry = h.state.calls[1]!.messages.at(-1)!.content;
	expect(retry).toContain("## Retry");
	expect(retry).toContain("execution_source_invalid");
	expect(retry).not.toContain("required");
});

test("a question asked again keeps the whole request it asked about", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: "ask", say: "何の絵にしましょうか？" }));
	await h.say("絵を描いて");
	h.state.steps.push(choice({ choice: "ask", say: "どんな猫ですか？" }));
	await h.say("猫で");
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "黒い猫の絵" }),
	);
	await h.say("黒い猫", "queued");
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain(
		"聞き返した依頼: 絵を描いて 猫で",
	);
});

test("a long request asked about twice keeps the newest answer with the head of the request", async () => {
	h = await setup({ harness: "local" });
	const request = `絵を描いて。${"背景の説明です。".repeat(40)}`;
	h.state.steps.push(choice({ choice: "ask", say: "何の絵にしましょうか？" }));
	await h.say(request);
	h.state.steps.push(choice({ choice: "ask", say: "どんな猫ですか？" }));
	await h.say("猫で");
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "黒い猫の絵" }),
	);
	await h.say("黒い猫", "queued");
	// What a carried call keeps (300 characters): the request's head and the answer whole.
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain(
		`聞き返した依頼: ${request.slice(0, 297)} 猫で\n`,
	);
});

test("no candidate fits: the talk turn answers, on a system that names no toolchain or tool and the time alone of the state", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: "none" }), { text: "こんにちは。" });
	const run = await h.say("こんにちは");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	const talk = h.state.calls.at(-1)!;
	expect(talk.tools).toEqual([]);
	expect(talk.session?.outputSchema).toBeUndefined();
	const system = talk.messages[0]!.content;
	for (const word of [
		"## Toolchains",
		"## Tools",
		"find_toolchain",
		"delegate",
	])
		expect(system).not.toContain(word);
	expect(system).toContain("この返事では、作業を始めることも");
	const last = talk.messages.at(-1)!.content;
	expect(last).toMatch(/^## State\n今: [^\n]+\n\n## User\nこんにちは$/);
});

test("a hand-over is announced with the choice's say, and the record keeps those same words", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	// The screen shows the run's announcement; nothing else was said.
	expect(waiting.announcement).toBe("描きますね。");
	expect(assistantTexts()).toEqual([]);
	expect(h.todos()[0]).toMatchObject({ title: "猫の絵", status: "todo" });
	expect(
		h.store
			.read((db) =>
				h!.conversation.input.utterancesAfterInTransaction(db, "main", 0),
			)
			.filter((u) => u.speaker === "agent")
			.map((u) => u.text),
	).toEqual(["描きますね。"]);
});

test("a change of something that exists is confirmed in the host's words; a yes approves it on the pending turn", async () => {
	h = await setup({
		harness: "local",
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
	expect(h.dialogue.answerText(asked.id)).toBe(
		"画像に「壁紙を差し替える」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(h.todos()).toEqual([]);
	h.state.steps.push(choice({ choice: "approve", confirmation: "c1" }));
	const approved = await h.say("お願い", "queued");
	const pending = h.state.calls.at(-1)!;
	expect(pending.messages.at(-1)!.content).toContain(
		"## Pending\n- c1 確認待ち: fake.image「壁紙を差し替える」",
	);
	expect(offered(pending.session?.outputSchema)).toEqual([
		"none",
		"approve",
		"decline",
	]);
	expect(approved.announcement).toBe(
		"頼みました。終わったら画面でお知らせします。",
	);
	expect(h.todos()[0]).toMatchObject({
		title: "壁紙を差し替える",
		status: "todo",
	});
});

test("a no on the pending turn closes the confirmation: the next turn has nothing pending", async () => {
	h = await setup({
		harness: "local",
		cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT],
	});
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "差し替えます。", request: "壁紙" }),
		choice({ choice: "decline", confirmation: "c1" }),
	);
	await h.say("壁紙を差し替えて");
	const declined = await h.say("やっぱりやめる");
	expect(h.dialogue.answerText(declined.id)).toBe(
		"わかりました。やめておきます。",
	);
	h.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
	await h.say("こんにちは");
	expect(
		h.state.calls.slice(-2).map((c) => c.messages.at(-1)!.content),
	).not.toContainEqual(expect.stringContaining("## Pending"));
});

test("a question back keeps the request it asked about; the answer goes to the request turn with both", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(choice({ choice: "ask", say: "何の絵にしましょうか？" }));
	const asked = await h.say("絵を描いて");
	expect(h.dialogue.answerText(asked.id)).toBe("何の絵にしましょうか？");
	h.state.steps.push(
		choice({ choice: IMAGE.id, say: "猫を描きますね。", request: "猫の絵" }),
	);
	await h.say("猫で", "queued");
	const input = h.state.calls.at(-1)!.messages.at(-1)!.content;
	expect(input).toContain("直前の返事: 何の絵にしましょうか？");
	expect(input).toContain("聞き返した依頼: 絵を描いて");
	expect(input).toEndWith("## User\n猫で");
	expect(h.todos()[0]).toMatchObject({ title: "猫の絵" });
});

test("a memory request goes to the steward from the user's words, and the choice's say is said", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(
		choice({
			choice: "memory.request",
			kind: "remember",
			what: "辛い物が好き",
			say: "覚えておきます。",
		}),
	);
	const run = await h.say("辛い物が好きって覚えておいて");
	expect(h.dialogue.answerText(run.id)).toBe("覚えておきます。");
	expect(h.state.stewardRequests).toHaveLength(1);
});

test("a memory read is told by the talk turn, with what was found as the host's notice", async () => {
	h = await setup({ harness: "local" });
	h.state.steps.push(
		choice({ choice: "memory.recall", query: "好きな食べ物" }),
		{ text: "記憶にはありませんでした。" },
	);
	const run = await h.say("私の好きな食べ物って何だっけ");
	expect(h.dialogue.answerText(run.id)).toBe("記憶にはありませんでした。");
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain(
		"## Host notice\n利用者に聞かれて、覚えている記録を確かめましたが、見つかりませんでした。",
	);
});

test("the talk turn's recent conversation is the last two of the user's utterances and the reply before them", async () => {
	h = await setup({ harness: "local" });
	for (let i = 1; i <= 4; i++) {
		h.state.steps.push(choice({ choice: "none" }), { text: `a${i}` });
		await h.say(`u${i}`);
	}
	const recent = h.state.calls
		.at(-1)!
		.messages.slice(2, -1)
		.map((m) => m.content);
	expect(recent).toEqual(["a1", "u2", "a2", "u3", "a3"]);
});
