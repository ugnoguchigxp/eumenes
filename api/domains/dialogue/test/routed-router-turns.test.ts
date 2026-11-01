import { afterEach, expect, test } from "bun:test";
import {
	EDIT,
	EXTRACT_UNSUPPORTED,
	ROUTER,
	VECTOR,
	fieldsAnswer,
	startRouter,
	traceOf,
	weigh,
} from "./router.fixture";
import {
	IMAGE,
	INSTANT,
	MUSIC,
	choice,
	type Harness,
	type SetupOptions,
} from "./generation.fixture";

/**
 * The router's hand-overs and what it learns from them (spec toolchain-router-redesign 2026-11-01): a redirect, a question asked once
 * more, the words a confirmation quotes, the router's own failures. The router and its store are fakes.
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

test("a confirmation quotes the user's words only, not the utterance before them nor any marker; so do the criteria of its answers", async () => {
	const r = await start({}, { cards: [IMAGE, EDIT] });
	r.scripts.push(weigh({ "conversation.respond": 0.9 }));
	h!.state.steps.push({ text: "いい色ですね。" });
	await h!.say("夕焼けの色が好き");
	r.scripts.push(weigh({ [EDIT.id]: 0.8 }));
	const asked = await h!.say("それを少し明るくして");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"編集に「それを少し明るくして」を頼みます。今あるものを変えます。よろしいですか？",
	);
	r.scripts.push(weigh({ "c1.approve": 0.9 }));
	await h!.say("お願い", "queued");
	const approve = r.routes
		.at(-1)!
		.criteria.find((c) => c.name === "c1.approve")!.description;
	expect(approve).toContain("それを少し明るくして");
	expect(approve).not.toContain("夕焼け");
	expect(approve).not.toContain("直前の発言");
	// The TODO the approval starts is titled by the words as well.
	expect(h!.todos()[0]).toMatchObject({ title: "それを少し明るくして" });
});

test("a doubted work is not cancelled before the new hand-over is certain: a fill that asks back leaves it running", async () => {
	const r = await start({}, { cards: [IMAGE, INSTANT] });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [INSTANT.id]: 0.4 }));
	await h!.say("絵を描いて", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${INSTANT.id}`]: 0.8 }));
	r.fieldScripts.push(async () => {
		throw new Error("fixture_fields_down");
	});
	h!.state.steps.push(choice({ choice: "ask", say: "どこの時刻ですか？" }));
	const asked = await h!.say("違う、時刻を知りたい");
	expect(h!.dialogue.answerText(asked.id)).toBe("どこの時刻ですか？");
	expect(h!.archived()).toEqual([]);
	expect(h!.todos()).toHaveLength(1);
});

test("a doubted work stays running when the new toolchain needs the user's yes: the confirmation says so", async () => {
	const r = await start({}, { cards: [IMAGE, EDIT] });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [EDIT.id]: 0.4 }));
	await h!.say("壁紙の絵を描いて", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${EDIT.id}`]: 0.8 }));
	const asked = await h!.say("違う、今の壁紙を直したい");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"編集に「壁紙の絵を描いて\n違う、今の壁紙を直したい」を頼みます。今あるものを変えます。よろしいですか？\n元の依頼は、確認が取れるまでそのまま続けます。".replace(
			"\n違う",
			" 違う",
		),
	);
	expect(h!.archived()).toEqual([]);
	expect(h!.todos()[0]).toMatchObject({ title: "壁紙の絵を描いて" });
	// Nothing was learned from a redirect that has not happened.
	expect(h!.state.feedback).toEqual([]);
});

test("a hand-over that fails after the old work was cancelled says both, with no model call to try again", async () => {
	// The music port is not offered: the redirect to the music toolchain is refused when it is dispatched.
	const r = await start({}, { cards: [IMAGE, MUSIC] });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	await h!.say("夕方に合うものを作って", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${MUSIC.id}`]: 0.8 }));
	const failed = await h!.say("違う、作曲してほしい");
	expect(h!.dialogue.answerText(failed.id)).toBe(
		"元の依頼は取りやめましたが、「作曲」への依頼はできませんでした。",
	);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	expect(h!.state.calls).toEqual([]);
});

test("a question back is answered by one of the two asked about, and by no other", async () => {
	const r = await start({}, { cards: [IMAGE, INSTANT, MUSIC], music: true });
	h!.state.vector = VECTOR;
	const unsure = () =>
		weigh({
			[IMAGE.id]: 0.25,
			[INSTANT.id]: 0.24,
			"conversation.respond": 0.2,
			"memory.request": 0.16,
			[MUSIC.id]: 0.15,
		});
	r.scripts.push(unsure(), weigh({ [MUSIC.id]: 0.9 }));
	await h!.say("何か作って");
	expect(trace().set).toEqual([IMAGE.id, INSTANT.id]);
	await h!.say("曲がいい", "queued");
	// Music was not one of the two: what the router asked about is not corrected by it.
	expect(h!.state.feedback).toEqual([]);
});

test("a cancellation asked about once more is done on a plain yes: the user was asked, so the lower line holds", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	await h!.say("猫の絵を描いて", "queued");
	r.scripts.push(weigh({ "t1.cancel": 0.5, "conversation.respond": 0.4 }));
	const asked = await h!.say("やめようかな");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「猫の絵を描いて」を取りやめますか？",
	);
	// The trace keeps what was asked about.
	expect(trace(1)).toMatchObject({ row: 6, decided: "t1.cancel" });
	// 0.4 would be asked about again on its own; after the question it is the user's yes.
	r.scripts.push(weigh({ "t1.cancel": 0.4, "conversation.respond": 0.35 }));
	const done = await h!.say("うん");
	expect(h!.dialogue.answerText(done.id)).toBe("承知しました。");
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
});

test("without the question before it, the same probability is asked about again", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.8 }));
	await h!.say("猫の絵を描いて", "queued");
	r.scripts.push(weigh({ "t1.cancel": 0.4, "conversation.respond": 0.35 }));
	const asked = await h!.say("うん");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「猫の絵を描いて」を取りやめますか？",
	);
	expect(h!.archived()).toEqual([]);
});

test("a redirect asked about is worded as doing it again, and its yes redirects the same work to the same toolchain", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	h!.state.vector = VECTOR;
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	await h!.say("コーヒータイムに合うものを作って", "queued");
	r.scripts.push(
		weigh({ [`t1.redirect:${MUSIC.id}`]: 0.5, "conversation.respond": 0.4 }),
	);
	const asked = await h!.say("違うかも");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「コーヒータイムに合うものを作って」を「作曲」でやり直しますか？",
	);
	expect(h!.archived()).toEqual([]);
	// The question's trace carries the work on: the yes finds the redirect on offer.
	r.scripts.push(
		weigh({ [`t1.redirect:${MUSIC.id}`]: 0.4, "conversation.respond": 0.35 }),
	);
	const done = await h!.say("うん", "queued");
	expect(done.announcement).toBe("「作曲」に頼みます。");
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	expect(h!.state.feedback).toEqual([
		expect.objectContaining({
			source: "redirect",
			wrongId: IMAGE.id,
			rightId: MUSIC.id,
			text: "コーヒータイムに合うものを作って",
		}),
	]);
});

test("a redirect that was carried out is what its trace decided, so the next redirect names the toolchain the work went to", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	h!.state.vector = VECTOR;
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	await h!.say("コーヒータイムに合うものを作って", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${MUSIC.id}`]: 0.8 }));
	await h!.say("違う、作曲して", "queued");
	expect(trace(1)).toMatchObject({
		decided: MUSIC.id,
		set: [IMAGE.id, MUSIC.id],
	});
	expect(trace(1).workId).toBe(h!.todos()[0]!.id);
	// The work t2 now lives at the music toolchain: it can be redirected back to the image toolchain.
	r.scripts.push(weigh({ "conversation.respond": 0.9 }));
	h!.state.steps.push({ text: "はい。" });
	await h!.say("うーん");
	expect(r.routes.at(-1)!.criteria.map((c) => c.name)).toContain(
		`t2.redirect:${IMAGE.id}`,
	);
});

test("corrections that disagree are put out of use for review, and the turn is decided as if there were none", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	h!.state.vector = VECTOR;
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
		{ id: "f2", wrongId: MUSIC.id, rightId: IMAGE.id, similarity: 0.99 },
	];
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.4 }));
	expect((await h!.say("朝に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼んでみます。",
	);
	expect(h!.state.feedbackStates).toEqual([
		{ id: "f1", state: "conflict" },
		{ id: "f2", state: "conflict" },
	]);
});

test("a read of the router's own that fails is a router failure: the turn talks (on), and only the log knows (shadow)", async () => {
	const r = await start();
	h!.state.failRouterRead = true;
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("絵を描いて");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(r.routes).toEqual([]);
	expect(trace()).toMatchObject({
		row: 0,
		decided: null,
		error: "fixture_router_read_failed",
	});
	await h!.close();
	h = undefined;
	const shadow = await start({ mode: "shadow" });
	h!.state.failRouterRead = true;
	h!.state.steps.push(choice({ choice: "none" }), { text: "はい。" });
	const untouched = await h!.say("こんにちは");
	expect(h!.dialogue.answerText(untouched.id)).toBe("はい。");
	expect(shadow.routes).toEqual([]);
});

test("a model that could not extract is not asked to again for ten minutes: the fill goes straight ahead", async () => {
	const r = await start();
	const refuse = async () => {
		throw new Error(EXTRACT_UNSUPPORTED);
	};
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }), weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(refuse);
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	await h!.say("東京は今何時？");
	expect(r.fieldCalls).toHaveLength(1);
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "大阪" } }));
	await h!.say("大阪は今何時？");
	expect(r.fieldCalls).toHaveLength(1);
	// After the time it is asked again.
	h!.state.offsetMs += 11 * 60 * 1000;
	r.scripts.push(weigh({ [INSTANT.id]: 0.9 }));
	r.fieldScripts.push(fieldsAnswer({ city: "京都" }));
	await h!.say("京都は今何時？");
	expect(r.fieldCalls).toHaveLength(2);
});

test("the router reads the whole utterance: the search keeps its own bound, the router cuts the text itself", async () => {
	const r = await start();
	r.scripts.push(weigh({ "conversation.respond": 0.9 }));
	h!.state.steps.push({ text: "はい。" });
	const long = `背景の説明です。${"あ".repeat(2500)}`;
	await h!.say(long);
	expect(r.routes[0]!.text).toBe(long);
});
