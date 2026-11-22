import { afterEach, expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import { IMAGE, INSTANT, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";
import { fillSchema } from "../service/routed-choice";

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
test("an instant toolchain fills the selected candidate’s arguments and returns its answer to the conversation", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h.state.calls).toHaveLength(4);
	const fill = h.state.calls[2];
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
		"会話エージェントが選んだ「## Candidates」の1件について",
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

test.each(["chat_output_empty", "cloud_agent_empty_output"])(
	"a talk that tells the user who spoke nothing gets the host's words (%s)",
	async (fail) => {
		h = await setup();
		h.state.steps.push(choice({ choice: "none" }), { fail });
		const run = await h.say("こんにちは");
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe(
			"うまく答えられませんでした。もう一度言ってもらえますか。",
		);
		expect(h.state.calls.map((call) => call.session?.retainRequest)).toEqual([
			true,
		]);
	},
);

test.each(["chat_output_empty", "cloud_agent_empty_output"])(
	"a completed silent continuation keeps the tool preamble without a failure reply (%s)",
	async (fail) => {
		h = await setup();
		h.state.steps.push(
			choice({ choice: "none" }),
			{
				text: "記録を確認します。",
				calls: [{ name: "read_history", args: {} }],
			},
			{ fail },
		);
		const run = await h.say("これまでの記録を見てください");
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("記録を確認します。");
		expect(h.state.calls).toHaveLength(2);
		expect(
			h.state.calls[1]!.messages.map((message) => String(message.role)),
		).toContain("tool");
	},
);

test("a pipeline keeps the conversation's request and needs no extra call to fill arguments", async () => {
	const pipeline: ToolchainCard = {
		...IMAGE,
		revisionId: "toolchain:fake.pipeline@1",
		id: "fake.pipeline",
		functionName: "fake_pipeline",
		title: "手順",
		execution: "pipeline",
	};
	h = await setup({ cards: [pipeline, INSTANT] });
	h.state.steps.push(
		choice({
			choice: pipeline.id,
			request: "雨の曲の手順を進めて",
			say: "手順を進めます。",
		}),
	);
	const run = await h.say("雨の曲の手順を進めて");
	expect(h.state.calls).toHaveLength(3);
	const schema = fillSchema(pipeline, { resources: [] }) as {
		anyOf: Array<{ properties: Record<string, { enum?: string[] }> }>;
	};
	const branch = schema.anyOf.find(
		(b) => b.properties.choice?.enum?.[0] === pipeline.id,
	)!;
	expect(Object.keys(branch.properties)).toEqual(["choice"]);
	expect(h.state.calls.every((call) => !call.session?.outputSchema)).toBe(true);
	expect(h.dialogue.answerText(run.id)).toBe(
		"その依頼は今の担当で実行できません。",
	);
});

test("a plain exchange can answer without calling its offered tools", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), { text: "こんにちは。" });
	const run = await h.say("こんにちは");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	const talk = h.state.calls.at(-1)!;
	// The read tools and static work/control tools this host has (kept fixed for KV cache stability).
	expect(talk.tools).toEqual([
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
	expect(talk.session?.outputSchema).toBeUndefined();
	const system = talk.messages[0]!.content;
	for (const word of [
		"## Toolchains",
		"## Tools",
		"find_toolchain",
		"delegate",
	])
		expect(system).not.toContain(word);
	expect(system).toContain("渡された読む道具で、記録");
	expect(system).toContain("受付、実行中、完了を区別");
	expect(system).toContain("今実行を頼まれていることを見極めます");
	expect(h.state.searchSlots).toEqual([]);
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
	const talked = h.state.calls.at(-1)!;
	expect(talked.tools).toContain("work");
	expect(talked.messages.at(-1)!.content).toContain(
		"t1「猫の絵を描いて」が終わりました（成功）。",
	);
	expect(h.todos()).toEqual([]);
});

test("the conversation resolves a past reference before the selected toolchain fills its arguments", async () => {
	h = await setup();
	h.state.steps.push(choice({ choice: "none" }), { text: "承知しました。" });
	await h.say("好きな都市は東京です。");
	const request = "東京の現在時刻を教えて";
	const first = h.state.calls.length;
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: request } }] },
		{ calls: [{ name: "delegate", args: { toolchain: INSTANT.id, request } }] },
		choice({ choice: INSTANT.id, inputs: { city: "東京" } }),
		{ text: "東京は12時です。" },
	);
	const run = await h.say("好きな都市の時刻を教えて");
	expect(
		h.state.calls[first]!.messages.some(
			({ role, content }) =>
				role === "user" && content.includes("好きな都市は東京です。"),
		),
	).toBe(true);
	const fill = h.state.calls.findLast((call) => call.session?.outputSchema)!;
	const input = fill.messages.at(-1)!.content;
	expect(input).toContain("## Earlier\n- 好きな都市は東京です。\n## State\n");
	expect(input).toContain("直前の返事: 承知しました。");
	expect(input).toEndWith(`## User\n${request}`);
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
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
	const input = h.state.calls
		.findLast((call) => call.session?.outputSchema)!
		.messages.at(-1)!.content;
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
