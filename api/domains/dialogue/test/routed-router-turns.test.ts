import { afterEach, expect, test } from "bun:test";
import { EDIT, ROUTER, startRouter, traceOf, weigh } from "./router.fixture";
import {
	IMAGE,
	INSTANT,
	MUSIC,
	choice,
	type Harness,
	type SetupOptions,
} from "./generation.fixture";

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
	const started = await startRouter(router, {
		...options,
	});
	h = started.h;
	return started;
}
const trace = (index = 0) => traceOf(h!, index);

test("a confirmation quotes the user's words only, not the utterance before them nor any marker; so do the criteria of its answers", async () => {
	const r = await start({}, { cards: [IMAGE, EDIT] });
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "いい色ですね。" });
	await h!.say("夕焼けの色が好き");
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
	const asked = await h!.say("それを少し明るくして");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"編集に「それを少し明るくして」を頼みます。今あるものを変えます。よろしいですか？",
	);
	r.scripts.push(weigh({ "c1.approve": 0.95 }));
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
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [INSTANT.id]: 0.45 }));
	await h!.say("絵を描いて", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${INSTANT.id}`]: 0.95 }));
	h!.state.steps.push(choice({ choice: "ask", say: "どこの時刻ですか？" }));
	const asked = await h!.say("違う、時刻を知りたい");
	expect(h!.dialogue.answerText(asked.id)).toBe("どこの時刻ですか？");
	expect(h!.archived()).toEqual([]);
	expect(h!.todos()).toHaveLength(1);
});

test("a doubted work stays running when the new toolchain needs the user's yes: the confirmation says so", async () => {
	const r = await start({}, { cards: [IMAGE, EDIT] });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [EDIT.id]: 0.45 }));
	await h!.say("壁紙の絵を描いて", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${EDIT.id}`]: 0.95 }));
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

test("a redirect that was carried out is what its trace decided, so the next redirect names the toolchain the work went to", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.45 }));
	await h!.say("コーヒータイムに合うものを作って", "queued");
	r.scripts.push(weigh({ [`t1.redirect:${MUSIC.id}`]: 0.95 }));
	await h!.say("違う、作曲して", "queued");
	expect(trace(1)).toMatchObject({
		decided: MUSIC.id,
	});
	expect(trace(1).set).toContain(IMAGE.id);
	expect(trace(1).set).toContain(MUSIC.id);
	expect(trace(1).workId).toBe(h!.todos()[0]!.id);
	// The work t2 now lives at the music toolchain: it can be redirected back to the image toolchain.
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "はい。" });
	await h!.say("うーん");
	expect(trace(2)).toMatchObject({
		decided: "conversation.respond",
		error: null,
	});
	expect(r.routes.at(-1)!.criteria.map((c) => c.name)).toEqual(
		expect.arrayContaining([
			expect.stringMatching(new RegExp("redirect:" + IMAGE.id + "$")),
		]),
	);
});

test("a read of the router's own that fails is a router failure: the request is held", async () => {
	const r = await start();
	h!.state.failRouterRead = true;
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("絵を描いて");
	expect(h!.dialogue.answerText(run.id)).toContain(
		"今回の作業はまだ実施していません",
	);
	expect(r.routes).toEqual([]);
	expect(trace()).toMatchObject({
		row: 0,
		decided: null,
		error: "fixture_router_read_failed",
	});
});

test("the router routes the entire supported utterance without truncating the structure input", async () => {
	const r = await start();
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "はい。" });
	const long = `背景の説明です。${"あ".repeat(1800)}`;
	await h!.say(long);
	expect(h!.state.routerEmbeds).toEqual([]);
	expect(r.routes[0]!.text).toBe(long);
	// The trace keeps the utterance (its record bounds it), not the head the router read.
	expect(h!.state.traces[0]!.text).toBe(long);
});
