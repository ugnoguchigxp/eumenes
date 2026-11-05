import { afterEach, expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import { IMAGE, INSTANT, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * The local harness's routed turn (spec router-package-integration 2026-11-04): the router (the eumenes_router package;
 * the fixture's context judgment reads a scripted choice as its top) decides; a toolchain with fields is filled by one
 * silent call held to that candidate's schema; the host carries it out and says its own words, or the talk turn
 * answers.
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
test("an instant toolchain the router decided answers from the inputs of the one fill call: the host says its answer", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.calls).toHaveLength(1);
	const [fill] = h.state.calls;
	expect(fill!.session).toMatchObject({
		sessionRole: "main",
		agentSession: { conversationId: "main", agentId: "main" },
	});
	expect(fill!.tools).toEqual([]);
	expect(offered(fill!.session?.outputSchema)).toEqual([
		"none",
		"ask",
		INSTANT.id,
	]);
	const input = fill!.messages.at(-1)!.content;
	expect(input).toContain("## State\n今: ");
	expect(input).toContain("## Candidates\n");
	expect(input).toContain(`- ${INSTANT.id}: `);
	expect(input).not.toContain(`- ${IMAGE.id}: `);
	expect(input).toEndWith("## User\n東京は今何時？");
	expect(fill!.messages[0]!.content).toContain(
		"振り分けが決めた「## Candidates」の1件に頼むための欄を",
	);
	expect(h.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("a talk cut before a word gets the host's words", async () => {
	h = await setup();
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
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), { fail: "chat_output_empty" });
	const run = await h.say("こんにちは");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(
		"うまく答えられませんでした。もう一度言ってもらえますか。",
	);
	expect(h.state.calls.map((call) => call.session?.retainRequest)).toEqual([
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
	h = await setup({ cards: [pipeline, INSTANT] });
	h.state.steps.push(choice({ choice: pipeline.id, inputs: { topic: "雨" } }));
	const run = await h.say("雨の曲の手順を進めて");
	// The fill's branch of a pipeline has its inputs and no request of its own.
	const branch = (
		h.state.calls[0]!.session!.outputSchema as {
			anyOf: Array<{ properties: Record<string, { enum?: string[] }> }>;
		}
	).anyOf.find((b) => b.properties.choice?.enum?.[0] === pipeline.id)!;
	expect(Object.keys(branch.properties)).toContain("inputs");
	expect(Object.keys(branch.properties)).not.toContain("request");
	// The hand-over went past the argument check (this fixture runs no pipelines): the host says it could not.
	expect(h.dialogue.answerText(run.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h.state.calls).toHaveLength(1);
});

test("no candidate fits: the talk turn answers with only the read tools, on a system that names no toolchain and the time alone of the state", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), { text: "こんにちは。" });
	const run = await h.say("こんにちは");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	const talk = h.state.calls.at(-1)!;
	// The read tools this host has (spec conversation-read-tools-design 2026-10-31): no memory or agents here.
	expect(talk.tools).toEqual(["read_history", "read_runs"]);
	expect(talk.session?.outputSchema).toBeUndefined();
	const system = talk.messages[0]!.content;
	for (const word of [
		"## Toolchains",
		"## Tools",
		"find_toolchain",
		"delegate",
	])
		expect(system).not.toContain(word);
	expect(system).toContain(
		"この返事でできるのは、読む道具が渡されているときに",
	);
	// Nor does it write what a toolchain makes: a page or a text it is asked for goes to a toolchain.
	expect(system).toContain(
		"文章・ページ・画面・コードなどの制作物は、この返事では書きません。",
	);
	const last = talk.messages.at(-1)!.content;
	expect(last).toMatch(/^## State\n今: [^\n]+\n\n## User\nこんにちは$/);
});

test("a no on the pending turn closes the confirmation: the next turn has nothing pending", async () => {
	h = await setup({
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

test("the talk turn's recent conversation is the last two of the user's utterances and the reply before them", async () => {
	h = await setup();
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

test("finished work State still lists may be checked, never corrected: the check's record is what the talk turn tells", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: IMAGE.id }));
	const waiting = await h.say("猫の絵を描いて", "queued");
	await h.finishImage(waiting.id, { state: "completed", title: "猫の絵" });
	expect(h.archived().map((todo) => todo.title)).toEqual(["猫の絵を描いて"]);
	h.state.steps.push(choice({ choice: "t1", operation: "check" }), {
		text: "猫の絵はできあがっています。",
	});
	const run = await h.say("猫の絵はどうなった？");
	expect(h.dialogue.answerText(run.id)).toBe("猫の絵はできあがっています。");
	// Finished work is offered to the router for a check only.
	const work = h.state.routerAsked
		.at(-1)!
		.criteria.map((c) => c.name)
		.filter((name) => name.startsWith("t1."));
	expect(work).toEqual(["t1.check"]);
	const talked = h.state.calls.at(-1)!;
	expect(talked.messages.at(-1)!.content).toContain(
		"仕事の記録を確かめた結果です",
	);
	expect(talked.messages.at(-1)!.content).toContain(
		"t1「猫の絵を描いて」が終わりました（成功）。",
	);
	expect(h.todos()).toEqual([]);
});

test("the fill reads the user's earlier words of the talk window: its fields carry the condition they point to", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), { text: "承知しました。" });
	await h.say("好きな都市は東京です。");
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	await h.say("好きな都市の時刻を教えて");
	const fill = h.state.calls.at(-1)!;
	expect(fill.session?.outputSchema).toBeDefined();
	const input = fill.messages.at(-1)!.content;
	expect(input).toContain("## Earlier\n- 好きな都市は東京です。\n## State\n");
	expect(input).toContain("直前の返事: 承知しました。");
	expect(fill.messages[0]!.content).toContain(
		"今の発言が「## Earlier」の発言や「## Memory」の項目を指しているときは、指された中身を request に書き写します。",
	);
});

test("the fill reads `## Memory` as the talk turn shows it", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
	const first = await h.say("好きな色は藍色です", "completed");
	const saved = await saveItem(h.store, h.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "好きな色は藍色",
		kind: "preference",
		semanticKey: "color.favorite",
		text: "好きな色は藍色",
	});
	await h.store.write((db) =>
		h!.memory!.republishWindowInTransaction(db, "main"),
	);
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	await h.say("好きな色の街の時刻を教えて");
	const input = h.state.calls.at(-1)!.messages.at(-1)!.content;
	expect(input).toStartWith("## Memory\n");
	expect(input).toContain(`- ${saved.text}`);
	expect(input.indexOf("## Memory")).toBeLessThan(input.indexOf("## State"));
});

test("a fill the provider failed (a cloud error) leaves the turn to the talk turn; the cloud got the fill's strict form", async () => {
	h = await setup();
	h.state.steps.push(
		choice({ choice: INSTANT.id }),
		{ fail: "cloud_http_429" },
		{ text: "はい、どうしましたか。" },
	);
	const run = await h.say("東京は今何時？");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe("はい、どうしましたか。");
	const [chose, talked] = h.state.calls.slice(-2);
	expect(chose!.session?.outputSchema).toBeDefined();
	expect(
		(chose!.session as { cloudOutputSchema?: { type?: string } })
			.cloudOutputSchema?.type,
	).toBe("object");
	expect(talked!.session?.outputSchema).toBeUndefined();
});
