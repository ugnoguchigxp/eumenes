import { afterEach, expect, test } from "bun:test";
import type { RouteInput } from "../../inference/contracts";
import type { ToolchainCard } from "../../capabilities";
import { confirmationResourceUris } from "../repository/resources";
import {
	EXTRACT_UNSUPPORTED,
	ROUTER,
	VECTOR,
	fieldsAnswer,
	names,
	startRouter,
	traceOf,
	weigh,
	type Script,
} from "./router.fixture";
import { fakeResources } from "./resource.fixture";
import {
	IMAGE,
	INSTANT,
	MUSIC,
	choice,
	type Harness,
	type SetupOptions,
} from "./generation.fixture";

/**
 * The router in the request turn (spec toolchain-router-redesign 2026-11-01): in `shadow` it looks beside the choice
 * call and changes nothing; in `on` it decides with no choice call, by the decision table, and the host carries the
 * decision out. The router, its second call and the store of its traces and corrections are fakes.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** A harness with the router saved as `router` says, kept in `h` for the test's end. */
async function start(
	router: Partial<typeof ROUTER> = {},
	options: SetupOptions = {},
) {
	const started = await startRouter(router, options);
	h = started.h;
	return started;
}
const trace = (index = 0) => traceOf(h!, index);

test("the router decides with no model call: a sure toolchain is handed the turn's words and announced in the host's words (row 2)", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.8, "conversation.respond": 0.1 }));
	const waiting = await h!.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	expect(h!.state.calls).toEqual([]);
	expect(h!.todos()[0]).toMatchObject({ title: "猫の絵を描いて" });
	// The search used the router's slots; the request carried its criteria, the host's words, in the host's order.
	expect(h!.state.searchSlots).toEqual(["router"]);
	const [asked] = r.routes;
	expect(names(asked!)).toEqual([
		"conversation.respond",
		INSTANT.id,
		IMAGE.id,
		"memory.request",
	]);
	expect(asked).toMatchObject({
		text: "猫の絵を描いて",
		previousAgent: null,
		previousUser: null,
		instructions: "利用者の今の発言を、どこへ渡すかを選んでください。",
	});
	expect(asked!.criteria[0]!.description).toBe(
		"仕事を始めず、話し相手として返事をする（雑談、感想、気持ち、相づち、エージェントへの質問）",
	);
	expect(h!.state.traceModes).toEqual(["on"]);
	expect(trace()).toMatchObject({ decided: IMAGE.id, row: 2 });
	// The work the hand-over started is linked to the trace, for a correction of it.
	expect(trace().workId).toBe(h!.todos()[0]!.id);
	expect(h!.state.selections.at(-1)).toMatchObject({ decision: "toolchain" });
});

test("the conversation leads: the turn talks, with one call and no choice (row 1)", async () => {
	const r = await start();
	r.scripts.push(weigh({ "conversation.respond": 0.9 }));
	h!.state.steps.push({ text: "いい天気ですね。" });
	const run = await h!.say("いい天気だね");
	expect(h!.dialogue.answerText(run.id)).toBe("いい天気ですね。");
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.calls[0]!.session?.outputSchema).toBeUndefined();
	expect(trace()).toMatchObject({ decided: "conversation.respond", row: 1 });
});

test("an unsure toolchain is asked to try, in the host's words (row 3)", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.45, [INSTANT.id]: 0.35 }));
	const waiting = await h!.say("絵か何か", "queued");
	expect(waiting.announcement).toBe("「画像」に頼んでみます。");
	expect(trace().row).toBe(3);
	// The best candidates until 0.9 together, three at most: the conversation holds the rest.
	expect(trace().set).toEqual([IMAGE.id, INSTANT.id, "conversation.respond"]);
});

test("an unsure toolchain that changes what exists is confirmed first (row 4), and a yes above the approval line approves it (row 5)", async () => {
	const r = await start(
		{},
		{ cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT] },
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.45, [INSTANT.id]: 0.15 }));
	const asked = await h!.say("壁紙を差し替えて");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"画像に「壁紙を差し替えて」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(trace().row).toBe(4);
	expect(h!.todos()).toEqual([]);
	r.scripts.push(weigh({ "c1.approve": 0.9, "c1.decline": 0.05 }));
	const approved = await h!.say("お願い", "queued");
	expect(approved.announcement).toBe(
		"頼みました。終わったら画面でお知らせします。",
	);
	expect(
		r.routes
			.at(-1)!
			.criteria.map((c) => c.name)
			.slice(-2),
	).toEqual(["c1.approve", "c1.decline"]);
	expect(trace(1).row).toBe(5);
	expect(h!.todos()[0]).toMatchObject({ title: "壁紙を差し替えて" });
	expect(h!.state.calls).toEqual([]);
});

test("a yes below the approval line asks the host's question again and leaves the confirmation open (row 5)", async () => {
	const r = await start(
		{},
		{ cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT] },
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	await h!.say("壁紙を差し替えて");
	r.scripts.push(weigh({ "c1.approve": 0.7, "c1.decline": 0.2 }));
	const again = await h!.say("うん");
	expect(h!.dialogue.answerText(again.id)).toBe(
		"「fake.image」の確認です。頼んでよいか、はい、またはいいえで答えてください。",
	);
	expect(h!.todos()).toEqual([]);
	// It is still open: the next turn offers it again, and a no closes it.
	r.scripts.push(weigh({ "c1.decline": 0.9, "c1.approve": 0.05 }));
	const declined = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(declined.id)).toBe(
		"わかりました。やめておきます。",
	);
	expect(r.routes.at(-1)!.criteria.map((c) => c.name)).toContain("c1.decline");
});

test("when nothing is sure the host asks between the best two, and the answer is the right toolchain for the words asked (row 8)", async () => {
	const r = await start();
	h!.state.vector = VECTOR;
	r.scripts.push(
		weigh({
			[IMAGE.id]: 0.29,
			[INSTANT.id]: 0.28,
			"conversation.respond": 0.22,
			"memory.request": 0.21,
		}),
	);
	const asked = await h!.say("絵を描いて");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「画像」と「時計」のどちらに頼みますか？",
	);
	// Nothing is decided yet: the user decides between the two.
	expect(trace()).toMatchObject({ row: 8, decided: null });
	r.scripts.push(weigh({ [IMAGE.id]: 0.9 }));
	const waiting = await h!.say("画像のほう", "queued");
	// The words asked about are joined to the answer, as the choice call's turn takes them.
	expect(r.routes.at(-1)!.text).toBe("絵を描いて\n画像のほう");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	expect(h!.state.feedback).toEqual([
		expect.objectContaining({
			source: "ask_answer",
			wrongId: null,
			rightId: IMAGE.id,
			text: "絵を描いて",
			query: VECTOR,
		}),
	]);
});

test("a question answered while the router was not sure of the words records nothing without a vector of them", async () => {
	const r = await start();
	r.scripts.push(
		weigh({
			[IMAGE.id]: 0.29,
			[INSTANT.id]: 0.28,
			"conversation.respond": 0.22,
			"memory.request": 0.21,
		}),
	);
	await h!.say("絵を描いて");
	r.scripts.push(weigh({ [IMAGE.id]: 0.9 }));
	await h!.say("画像のほう", "queued");
	expect(h!.state.feedback).toEqual([]);
});

test("several jobs in one request: the first is handed over and the rest are said not to be asked yet (row 9)", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	r.scripts.push(
		weigh(
			{ [IMAGE.id]: 0.6, [MUSIC.id]: 0.3 },
			{ [IMAGE.id]: 0.9, [MUSIC.id]: 0.8 },
		),
	);
	const waiting = await h!.say("猫の絵を描いて、曲も作って", "queued");
	expect(waiting.announcement).toBe(
		"「画像」に頼みます。ほかの作業はまだ頼んでいません。",
	);
	expect(trace().row).toBe(9);
});

test("a router that failed leaves the turn to the talk turn, and the trace says it failed (row 10)", async () => {
	const r = await start();
	r.scripts.push(async () => {
		throw new Error("larm_route_truncated");
	});
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("絵を描いて");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(trace()).toMatchObject({
		row: 0,
		decided: null,
		error: "larm_route_truncated",
	});
	expect(h!.todos()).toEqual([]);
});

test("a router that does not answer within the saved time is a failure of its own: the turn talks", async () => {
	const r = await start({ timeoutMs: 100 });
	r.scripts.push(
		(_input, signal) =>
			new Promise((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason)),
			),
	);
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("絵を描いて");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(trace()).toMatchObject({ row: 0, error: "timeout" });
});

test("a toolchain with free fields is filled by the router's second call, with no model call", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(fieldsAnswer({ city: "東京" }));
	const run = await h!.say("東京は今何時？");
	expect(h!.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h!.state.calls).toEqual([]);
	expect(r.fieldCalls).toEqual([
		{
			text: "東京は今何時？",
			previousAgent: null,
			previousUser: null,
			choices: {},
			extract: {
				instructions:
					"利用者の発言から、「時計」に必要な値を取り出してください。発言に無い値は null にします。",
				schema: {
					type: "object",
					required: ["city"],
					properties: { city: { type: "string" } },
				},
			},
		},
	]);
});

/** An instant toolchain with an enumerated field and two free ones. */
const WEATHER: ToolchainCard = {
	...INSTANT,
	instant: {
		parameters: {
			type: "object",
			properties: {
				day: {
					type: "string",
					enum: ["today", "tomorrow"],
					description: "いつの天気か",
				},
				place: { type: "string", description: "言われた地名" },
				prefecture: { type: "string" },
			},
			required: ["day", "place"],
		},
		parse: (args) => ({ ok: true, value: args as Record<string, unknown> }),
	},
};

test("an enumerated field is a choice of the second call, the free ones one extraction; a required field left empty is filled by the model", async () => {
	const r = await start({}, { cards: [IMAGE, WEATHER] });
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }), weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(
		fieldsAnswer({ place: "鎌倉", prefecture: null }, { day: "tomorrow" }),
	);
	const run = await h!.say("明日の鎌倉の天気は？");
	expect(h!.dialogue.answerText(run.id)).toBe("東京は12時です。");
	const [asked] = r.fieldCalls;
	expect(asked!.choices).toEqual({
		day: {
			instructions: "いつの天気か",
			criteria: [
				{ name: "today", description: "today" },
				{ name: "tomorrow", description: "tomorrow" },
			],
		},
	});
	expect(asked!.extract!.schema).toEqual({
		type: "object",
		required: ["place"],
		properties: {
			place: { type: "string", description: "言われた地名" },
			prefecture: { type: "string" },
		},
	});
	expect(h!.state.calls).toEqual([]);
	// The place is left null: the one-candidate fill reads the words instead.
	r.fieldScripts.push(
		fieldsAnswer({ place: null, prefecture: null }, { day: "today" }),
	);
	h!.state.steps.push(
		choice({ choice: INSTANT.id, inputs: { day: "today", place: "横浜" } }),
	);
	const filled = await h!.say("横浜は？");
	expect(h!.dialogue.answerText(filled.id)).toBe("東京は12時です。");
	expect(h!.state.calls).toHaveLength(1);
});

test("when the second call cannot extract, the one-candidate fill is the only model call, held to that candidate", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(async () => {
		throw new Error(EXTRACT_UNSUPPORTED);
	});
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h!.say("東京は今何時？");
	expect(h!.dialogue.answerText(run.id)).toBe("東京は12時です。");
	expect(h!.state.calls).toHaveLength(1);
	const [fill] = h!.state.calls;
	const branches = (
		fill!.session!.outputSchema as {
			anyOf: Array<{ properties: { choice: { enum: string[] } } }>;
		}
	).anyOf.flatMap((branch) => branch.properties.choice.enum);
	expect(branches).toEqual(["none", "ask", INSTANT.id]);
	const input = fill!.messages.at(-1)!.content;
	expect(input).toContain(`- ${INSTANT.id}: `);
	expect(input).not.toContain(`- ${IMAGE.id}: `);
	expect(fill!.messages[0]!.content).toContain("利用者の今の発言から埋めます");
});

test("a fill that finds nothing to ask for leaves the turn to the talk turn; one that asks back keeps the request it asked about", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }), weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(async () => {
		throw new Error(EXTRACT_UNSUPPORTED);
	});
	h!.state.steps.push(choice({ choice: "none" }), { text: "どこでしょう。" });
	const none = await h!.say("時刻は？");
	expect(h!.dialogue.answerText(none.id)).toBe("どこでしょう。");
	h!.state.steps.push(choice({ choice: "ask", say: "どこの時刻ですか？" }));
	const asked = await h!.say("時刻を教えて");
	expect(h!.dialogue.answerText(asked.id)).toBe("どこの時刻ですか？");
	// Another model of the router: the refusal of the first is not held against it.
	r.scripts.push(
		weigh({ [INSTANT.id]: 0.9 }, undefined, "another-router-model"),
	);
	r.fieldScripts.push(fieldsAnswer({ city: "東京" }));
	await h!.say("東京");
	expect(r.routes.at(-1)!.text).toBe("時刻を教えて\n東京");
});

test("a hand-over the host refuses is said in the host's failure words, with no model call to try again", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(fieldsAnswer({ city: null }));
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: {} }));
	const run = await h!.say("時刻は？");
	expect(h!.dialogue.answerText(run.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	// The fill is the only call; its refused inputs are not made again.
	expect(h!.state.calls).toHaveLength(1);
});

test("an instant toolchain that cannot answer gets the failure words, with no other candidate tried", async () => {
	const r = await start();
	h!.state.instantAnswer = null;
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(fieldsAnswer({ city: "東京" }));
	const run = await h!.say("東京は今何時？");
	expect(h!.dialogue.answerText(run.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h!.state.calls).toEqual([]);
});

test("a memory request takes its kind from the second call's choice and its content from the extraction", async () => {
	const r = await start();
	r.scripts.push(weigh({ "memory.request": 0.9 }));
	r.fieldScripts.push(
		fieldsAnswer({ what: "辛い物が好き", detail: null }, { kind: "remember" }),
	);
	const run = await h!.say("辛い物が好きって覚えておいて");
	expect(h!.dialogue.answerText(run.id)).toBe("承知しました。");
	expect(h!.state.stewardRequests).toEqual([
		expect.objectContaining({ kind: "remember", what: "辛い物が好き" }),
	]);
	expect(r.fieldCalls[0]!.choices.kind!.criteria.map((c) => c.name)).toEqual([
		"forget",
		"remember",
		"correct",
		"goal",
		"withdraw",
	]);
});

test("a work is checked, corrected or cancelled by the router's choice: the host's operation, the host's words", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	const waiting = await h!.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	r.scripts.push(weigh({ "t1.cancel": 0.8, "t1.check": 0.1 }));
	const cancelled = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(cancelled.id)).toBe("承知しました。");
	expect(
		r.routes
			.at(-1)!
			.criteria.map((c) => c.name)
			.slice(-4),
	).toEqual(["t1.check", "t1.amend", "t1.cancel", `t1.redirect:${INSTANT.id}`]);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	// Below the adoption line a cancellation is asked about, not done.
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	await h!.say("もう一度絵を描いて", "queued");
	r.scripts.push(weigh({ "t2.cancel": 0.5, "conversation.respond": 0.4 }));
	const asked = await h!.say("やめようかな");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「もう一度絵を描いて」を取りやめますか？",
	);
	expect(h!.todos()).toHaveLength(1);
});

test("a doubted hand-over is redone elsewhere: the work is cancelled, the same words go to the other toolchain, and the correction is kept", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	h!.state.vector = VECTOR;
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	const first = await h!.say("コーヒータイムに合うものを作って", "queued");
	expect(first.announcement).toBe("「画像」に頼んでみます。");
	expect(trace().set).toEqual([IMAGE.id, MUSIC.id]);
	r.scripts.push(
		weigh({ [`t1.redirect:${MUSIC.id}`]: 0.8, [`t1.cancel`]: 0.1 }),
	);
	const redone = await h!.say("違う、作曲してほしい", "queued");
	expect(redone.announcement).toBe("「作曲」に頼みます。");
	expect(r.routes.at(-1)!.criteria.map((c) => c.name)).toContain(
		`t1.redirect:${MUSIC.id}`,
	);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	const [made] = h!.todos();
	expect(made).toBeDefined();
	expect(h!.state.selections.at(-1)).toMatchObject({
		toolchainId: MUSIC.id,
		request: "コーヒータイムに合うものを作って\n違う、作曲してほしい",
	});
	expect(h!.state.feedback).toEqual([
		expect.objectContaining({
			source: "redirect",
			wrongId: IMAGE.id,
			rightId: MUSIC.id,
			text: "コーヒータイムに合うものを作って",
			query: VECTOR,
		}),
	]);
});

test("the user's utterance before the words goes to the toolchain with them, as the host's template says", async () => {
	const r = await start();
	r.scripts.push(
		weigh({ "conversation.respond": 0.9 }),
		weigh({ [IMAGE.id]: 0.8 }),
	);
	h!.state.steps.push({ text: "いい色ですね。" });
	await h!.say("夕焼けの色が好き");
	await h!.say("それを絵にして", "queued");
	expect(r.routes.at(-1)!.previousUser).toBe("夕焼けの色が好き");
	expect(r.routes.at(-1)!.previousAgent).toBe("いい色ですね。");
	const request = h!.state.selections.at(-1)!.request as string;
	expect(request).toStartWith("それを絵にして\n直前の発言（");
	expect(request).toContain("夕焼けの色が好き");
	// The work's title is the words, not the context behind them.
	expect(h!.todos()[0]).toMatchObject({ title: "それを絵にして" });
});

test("a correction near the utterance flips the decision; one far from it does not; corrections that disagree apply none", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	h!.state.vector = VECTOR;
	const ambiguous = () => weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 });
	// Without any correction the image leads.
	r.scripts.push(ambiguous());
	expect((await h!.say("夕方に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼んでみます。",
	);
	// A correction at 0.99 (line 0.95) moves the music above the image.
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
	];
	r.scripts.push(ambiguous());
	expect(
		(await h!.say("夕暮れに合うものを作って", "queued")).announcement,
	).toBe("「作曲」に頼みます。");
	// One below the line is not found: nothing moves.
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.9 },
	];
	r.scripts.push(ambiguous());
	expect((await h!.say("お昼に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼んでみます。",
	);
	// Two near corrections naming different right answers cancel each other.
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
		{ id: "f2", wrongId: MUSIC.id, rightId: IMAGE.id, similarity: 0.99 },
	];
	r.scripts.push(ambiguous());
	expect((await h!.say("朝に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼んでみます。",
	);
	const flipped = h!.state.traces[1] as unknown as { runId: string };
	expect(flipped.runId).not.toBe(trace(0).runId);
});

test("the weight 0 turns the corrections off", async () => {
	const r = await start(
		{ feedbackWeight: 0 },
		{ cards: [IMAGE, MUSIC], music: true },
	);
	h!.state.vector = VECTOR;
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
	];
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	expect(
		(await h!.say("夕暮れに合うものを作って", "queued")).announcement,
	).toBe("「画像」に頼んでみます。");
});

test("with the router off, or with no profile saved, the turn is today's: a choice call, and the router is not asked", async () => {
	for (const router of [{ mode: "off" as const }, { profile: undefined }]) {
		const r = await start(router);
		r.scripts.push(weigh({ [IMAGE.id]: 0.9 }));
		h!.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
		const run = await h!.say("こんにちは");
		expect(h!.dialogue.answerText(run.id)).toBe("はい。");
		expect(r.routes).toEqual([]);
		expect(h!.state.calls).toHaveLength(2);
		expect(h!.state.searchSlots).toEqual([undefined]);
		await h!.close();
		h = undefined;
	}
});

test("shadow: the same calls and answers as without it, one trace of what the router would decide, asked beside the choice call", async () => {
	const turn = async (mode: "off" | "shadow") => {
		const r = await start({ mode });
		r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
		// The choice call waits for the router: they run together.
		let release!: () => void;
		if (mode === "shadow") {
			h!.state.gate = new Promise<void>((resolve) => (release = resolve));
			const route = (h!.larm as unknown as { route: Script }).route;
			Object.assign(h!.larm, {
				route: async (input: RouteInput, signal: AbortSignal) => {
					const answered = await route(input, signal);
					release();
					return answered;
				},
			});
		}
		h!.state.steps.push(
			choice({ choice: IMAGE.id, say: "描きますね。", request: "猫の絵" }),
		);
		const waiting = await h!.say("猫の絵を描いて", "queued");
		const seen = {
			announcement: waiting.announcement,
			calls: h!.state.calls.length,
			todos: h!.todos().map((todo) => todo.title),
			log: h!.log().map((event) => event.type),
			selections: h!.state.selections.length,
			schema: h!.state.calls[0]!.session?.outputSchema,
			input: h!.state.calls[0]!.messages.at(-1)!.content,
		};
		const out = {
			seen,
			traces: h!.state.traces,
			modes: h!.state.traceModes,
			slots: h!.state.searchSlots,
		};
		await h!.close();
		h = undefined;
		return out;
	};
	const off = await turn("off");
	const shadow = await turn("shadow");
	expect(shadow.seen).toEqual(off.seen);
	expect(off.traces).toEqual([]);
	expect(shadow.modes).toEqual(["shadow"]);
	expect(shadow.traces[0]).toMatchObject({ decided: IMAGE.id });
	// Today's search first, then the router's slots.
	expect(shadow.slots).toEqual([undefined, "router"]);
});

test("shadow: a router that fails only reaches the log; the turn is untouched and the trace says it failed", async () => {
	const r = await start({ mode: "shadow" });
	r.scripts.push(async () => {
		throw new Error("larm_route_truncated");
	});
	h!.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
	const run = await h!.say("こんにちは");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(trace()).toMatchObject({
		row: 0,
		decided: null,
		error: "larm_route_truncated",
	});
	expect(h!.state.traceModes).toEqual(["shadow"]);
});

test("shadow: a router that never answers does not hold the turn longer than its saved time", async () => {
	const r = await start({ mode: "shadow", timeoutMs: 100 });
	r.scripts.push(
		(_input, signal) =>
			new Promise((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason)),
			),
	);
	h!.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
	const started = Date.now();
	const run = await h!.say("こんにちは");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(Date.now() - started).toBeLessThan(2000);
	expect(trace()).toMatchObject({ row: 0, error: "timeout" });
});

test("a turn the judge found no request in offers the router only the open confirmations: nothing is searched", async () => {
	const r = await start(
		{},
		{ cards: [{ ...IMAGE, minImpact: "modify_existing" }, INSTANT] },
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	await h!.say("壁紙を差し替えて");
	const searches = h!.state.searchSlots.length;
	// The judge now reads every utterance as chat.
	const saved = h!.larm.snapshotInTransaction!.bind(h!.larm);
	Object.assign(h!.larm, {
		snapshotInTransaction: (db: never) => ({
			...saved(db),
			intent: {
				mode: "ruri",
				profile: "judge-fixture-profile",
				timeoutMs: 1500,
				searchScore: 0.6,
			},
		}),
		judgeIntent: async () => ({
			choice: "chat",
			probabilities: {
				request: 0.1,
				chat: 0.9,
				followup: 0,
				noise: 0,
				incomplete: 0,
			},
			model: "judge-fixture-model",
			headRevision: "head-1",
			truncated: false,
			historyTokensDropped: 0,
			stateTokensDropped: 0,
		}),
	});
	r.scripts.push(weigh({ "c1.decline": 0.9 }));
	const declined = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(declined.id)).toBe(
		"わかりました。やめておきます。",
	);
	expect(names(r.routes.at(-1)!)).toEqual([
		"conversation.respond",
		"c1.approve",
		"c1.decline",
	]);
	expect(h!.state.searchSlots).toHaveLength(searches);
});

test("the resources State presents go with a hand-over the router decided, for the agent to pick from", async () => {
	const resources = fakeResources({ [IMAGE.id]: ["image"] });
	// A toolchain that changes what exists: its hand-over is confirmed, and the confirmation keeps what was handed over.
	const EDIT = {
		...IMAGE,
		id: "fake.edit",
		revisionId: "toolchain:fake.edit@1",
		functionName: "fake_edit",
		title: "編集",
		minImpact: "modify_existing" as const,
	};
	const r = await start(
		{},
		{ resources: resources.access, cards: [IMAGE, EDIT] },
	);
	resources.make("image", "image_1", "夜のドライブ");
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	const waiting = await h!.say("夜のドライブの絵を描いて", "queued");
	await h!.finishImage(waiting.id, {
		state: "completed",
		title: "夜のドライブ",
		resourceId: "image_1",
	});
	r.scripts.push(weigh({ [EDIT.id]: 0.8 }));
	await h!.say("これを少し明るくして");
	const kept = h!.store.read((db) =>
		(
			db.query("SELECT id FROM dialogue_confirmations").all() as Array<{
				id: string;
			}>
		).flatMap((row) => confirmationResourceUris(db, row.id)),
	);
	expect(kept).toEqual([expect.stringContaining("image_1")]);
});
