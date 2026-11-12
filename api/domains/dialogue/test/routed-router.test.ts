import { afterEach, expect, test } from "bun:test";
import { TURN_STRUCTURE_PROMPT } from "eumenes_router";
import { insertAgencyWork } from "../repository/agency";
import { confirmationResourceUris } from "../repository/resources";
import { insertWork } from "../repository/work";
import {
	EDIT,
	ROUTER,
	VECTOR,
	names,
	startRouter,
	traceOf,
	weigh,
} from "./router.fixture";
import { fakeResources } from "./resource.fixture";
import {
	DIRECT_ROUTER_MODEL,
	IMAGE,
	INSTANT,
	MUSIC,
	choice,
	type Harness,
	type SetupOptions,
} from "./generation.fixture";

/**
 * The router (spec router-package-integration 2026-11-04): with `on`, the eumenes_router package decides every
 * utterance turn with no choice call, and the host carries the decision out. LARM's context judgment, the embedding,
 * the package's tables and best-v2 are fakes (generation.fixture: a score of 0.95 is a sure top, 0.45 a top that is
 * not sure, and the conversation leads when nothing scores); the package's own logic is its own.
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

test("the package decides with no model call: a sure toolchain is offered by the host, handed the words and announced in the host's words (row 2)", async () => {
	const r = await start();
	h!.state.vector = VECTOR;
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	const waiting = await h!.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	expect(h!.state.calls).toEqual([]);
	expect(r.structureCalls).toEqual([]);
	expect(r.routes).toHaveLength(1);
	expect(h!.todos()[0]).toMatchObject({ title: "猫の絵を描いて" });
	// The utterance was embedded as the package's memory was; the reranker read the tools and a memory request (never
	// the conversation), the newest utterance and the host's instructions.
	expect(h!.state.routerEmbeds).toEqual(["猫の絵を描いて"]);
	const [asked] = r.routes;
	expect(names(asked!).sort()).toEqual(
		[IMAGE.id, INSTANT.id, "memory.request"].sort(),
	);
	expect(asked).toMatchObject({
		text: "猫の絵を描いて",
		previousAgent: null,
		previousUser: null,
		instructions: expect.stringContaining("切替はそれだけで実施する依頼です。"),
	});
	expect(asked!.criteria.find((c) => c.name === IMAGE.id)!.description).toBe(
		"画像: 画像を作る 例: 絵を描く",
	);
	// The host offered what the package ranked, by id, through its own operation.
	expect(h!.state.searchSlots).toEqual([[IMAGE.id, INSTANT.id]]);
	expect(trace()).toMatchObject({ decided: IMAGE.id, row: 2, query: VECTOR });
	expect(h!.state.traces[0]).toMatchObject({ text: "猫の絵を描いて" });
	// The work the hand-over started is linked to the trace, for a correction of it.
	expect(trace().workId).toBe(h!.todos()[0]!.id);
	// The record of the choice keeps the query's vector, as a search's does (procedures and past choices are found by it).
	expect(h!.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		query: VECTOR,
	});
});

test("the conversation leads when no tool scores: the turn talks, with one call and no choice", async () => {
	const r = await start();
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "いい天気ですね。" });
	const run = await h!.say("いい天気だね");
	expect(h!.dialogue.answerText(run.id)).toBe("いい天気ですね。");
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.calls[0]!.session?.outputSchema).toBeUndefined();
	expect(trace()).toMatchObject({ decided: "conversation.respond", row: 7 });
});

test("a deferred A is dispatched once using B's confirmed decision", async () => {
	const r = await start();
	const request = "絵か何か";
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }), weigh({ [IMAGE.id]: 0.95 }));
	r.structures.push(
		JSON.stringify({
			requests: [{ text: request, target: "絵", inputs: [], after: [] }],
		}),
	);
	const waiting = await h!.say(request, "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	expect(trace().row).toBe(2);
	expect(r.routes).toHaveLength(2);
	expect(r.structureCalls).toHaveLength(1);
	expect(h!.todos()).toHaveLength(1);
});

test("B's decision to change what exists still requires approval from the host", async () => {
	const r = await start({}, { cards: [EDIT, INSTANT] });
	r.scripts.push(weigh({ [EDIT.id]: 0.45 }), weigh({ [EDIT.id]: 0.95 }));
	r.structures.push(
		'{"requests":[{"text":"壁紙を差し替えて","target":"壁紙","inputs":[],"after":[]}]}',
	);
	const asked = await h!.say("壁紙を差し替えて");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"編集に「壁紙を差し替えて」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(trace().row).toBe(2);
	expect(r.structureCalls).toHaveLength(1);
	expect(h!.todos()).toEqual([]);
	r.scripts.push(weigh({ "c1.approve": 0.95 }));
	const approved = await h!.say("お願い", "queued");
	expect(approved.announcement).toBe(
		"頼みました。終わったら画面でお知らせします。",
	);
	expect(names(r.routes.at(-1)!)).toEqual(
		expect.arrayContaining(["c1.approve", "c1.decline"]),
	);
	expect(trace(1).row).toBe(5);
	expect(h!.todos()[0]).toMatchObject({ title: "壁紙を差し替えて" });
	expect(h!.state.calls).toEqual([]);
});

test("a yes below the approval line asks the host's question again and leaves the confirmation open; a sure no closes it", async () => {
	const r = await start({}, { cards: [EDIT, INSTANT] });
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
	await h!.say("壁紙を差し替えて");
	r.scripts.push(weigh({ "c1.approve": 0.55 }));
	const again = await h!.say("うん");
	expect(h!.dialogue.answerText(again.id)).toBe(
		"「fake.edit」の確認です。頼んでよいか、はい、またはいいえで答えてください。",
	);
	expect(h!.todos()).toEqual([]);
	r.scripts.push(weigh({ "c1.decline": 0.95 }));
	const declined = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(declined.id)).toBe(
		"わかりました。やめておきます。",
	);
});

test("route(): row 9 never dispatches only the first job when no planner is available", async () => {
	const r = await start(
		{},
		{ cards: [IMAGE, MUSIC], music: true, routerModel: DIRECT_ROUTER_MODEL },
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.95, [MUSIC.id]: 0.9 }));
	h!.state.steps.push({ text: "パイプラインを利用できません。" });
	const waiting = await h!.say("猫の絵を描いて、曲も作って");
	expect(h!.dialogue.answerText(waiting.id)).toBe(
		"パイプラインを利用できません。",
	);
	expect(h!.todos()).toHaveLength(0);
	expect(trace().decided).not.toBe(IMAGE.id);
});

test("a router that fails, is slow, has no memory or no embedding leaves the turn to the talk turn; the trace says why (row 10)", async () => {
	const cases: Array<{
		router?: Partial<typeof ROUTER>;
		arrange: (r: Awaited<ReturnType<typeof start>>) => void;
		error: string;
		asked: boolean;
	}> = [
		{
			arrange: (r) =>
				r.scripts.push(async () => {
					throw new Error("larm_route_truncated");
				}),
			error: "larm_route_truncated",
			asked: true,
		},
		{
			router: { timeoutMs: 100 },
			arrange: (r) =>
				r.scripts.push(
					(_input, signal) =>
						new Promise((_, reject) =>
							signal.addEventListener("abort", () => reject(signal.reason)),
						),
				),
			error: "timeout",
			asked: true,
		},
		{
			arrange: () => {
				h!.state.routerMemory = false;
			},
			error: "router_memory_missing",
			asked: false,
		},
		{
			arrange: () => {
				h!.state.routerEmbedFails = "embedding_unavailable";
			},
			error: "embedding_unavailable",
			asked: false,
		},
	];
	for (const c of cases) {
		const r = await start(c.router);
		c.arrange(r);
		h!.state.steps.push({ text: "はい。" });
		const run = await h!.say("絵を描いて");
		expect(h!.dialogue.answerText(run.id)).toBe("はい。");
		expect(trace()).toMatchObject({ row: 0, decided: null, error: c.error });
		expect(r.routes.length > 0).toBe(c.asked);
		expect(h!.todos()).toEqual([]);
		await h!.close();
		h = undefined;
	}
});

test("a toolchain with inputs is filled by the one-candidate call, the only model call, held to that candidate", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.95 }));
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
});

test("a fill that finds nothing to ask for leaves the turn to the talk turn; one that asks back keeps the request it asked about", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.95 }), weigh({ [INSTANT.id]: 0.95 }));
	h!.state.steps.push(choice({ choice: "none" }), { text: "どこでしょう。" });
	const none = await h!.say("時刻は？");
	expect(h!.dialogue.answerText(none.id)).toBe("どこでしょう。");
	h!.state.steps.push(choice({ choice: "ask", say: "どこの時刻ですか？" }));
	const asked = await h!.say("時刻を教えて");
	expect(h!.dialogue.answerText(asked.id)).toBe("どこの時刻ですか？");
	r.scripts.push(weigh({ [INSTANT.id]: 0.95 }));
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	await h!.say("東京");
	expect(r.routes.at(-1)!.text).toBe("時刻を教えて\n東京");
});

test("a hand-over the host refuses is said in the host's failure words, with no call to try again; an instant toolchain that ran without an answer leaves the request to the talk turn, told what failed", async () => {
	const r = await start();
	r.scripts.push(weigh({ [INSTANT.id]: 0.95 }));
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: {} }));
	const refused = await h!.say("時刻は？");
	expect(h!.dialogue.answerText(refused.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h!.state.calls).toHaveLength(1);
	h!.state.instantAnswer = null;
	r.scripts.push(weigh({ [INSTANT.id]: 0.95 }));
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	h!.state.steps.push({ text: "時刻は分かりませんでした。" });
	const unanswered = await h!.say("東京は今何時？");
	expect(h!.dialogue.answerText(unanswered.id)).toBe(
		"時刻は分かりませんでした。",
	);
	// The fill, then the talk: it reads the user's words with the host's notice of what could not be answered.
	expect(h!.state.calls).toHaveLength(3);
	expect(h!.state.calls[2]!.session?.outputSchema).toBeUndefined();
	const told = String(h!.state.calls[2]!.messages.at(-1)!.content);
	expect(told).toContain("## Host notice");
	expect(told).toContain(`担当「${INSTANT.title}」`);
	expect(told).toContain("lookup_failed");
});

test("a memory request is filled by the one-candidate call and taken by the host's operation", async () => {
	const r = await start();
	r.scripts.push(weigh({ "memory.request": 0.95 }));
	h!.state.steps.push(
		choice({
			choice: "memory.request",
			kind: "remember",
			what: "辛い物が好き",
		}),
	);
	const run = await h!.say("辛い物が好きって覚えておいて");
	expect(h!.dialogue.answerText(run.id)).toBe("承知しました。");
	expect(h!.state.stewardRequests).toEqual([
		expect.objectContaining({ kind: "remember", what: "辛い物が好き" }),
	]);
});

test("a cancellation carries the running request's identifying detail beyond its opening words", async () => {
	const r = await start();
	const marker = "対象は海辺の灯台の案内図",
		request = `${"これは描画の確認用です。".repeat(4)}${marker}です。`;
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say(request, "queued");
	r.scripts.push(weigh({ "t1.cancel": 0.95 }));
	await h!.say("先ほどの案内図を作る仕事を中止してください");
	const candidate = r.routes
		.at(-1)!
		.criteria.find((c) => c.name === "t1.cancel");
	expect(candidate?.description).toContain(marker);
	expect(candidate?.description).toContain("現在進行中の依頼");
	expect(h!.todos()).toHaveLength(0);
	expect(h!.archived()).toHaveLength(1);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
});

test("a work is checked, corrected or cancelled by the package's decision: the host's operation, the host's words", async () => {
	const r = await start({}, { routerModel: DIRECT_ROUTER_MODEL });
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("猫の絵を描いて", "queued");
	r.scripts.push(weigh({ "t1.cancel": 0.95 }));
	const cancelled = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(cancelled.id)).toBe("承知しました。");
	expect(names(r.routes.at(-1)!)).toEqual(
		expect.arrayContaining(["t1.check", "t1.amend", "t1.cancel"]),
	);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	// Below the adoption line a cancellation is asked about, not done.
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("もう一度絵を描いて", "queued");
	r.scripts.push(weigh({ "t2.cancel": 0.41 }));
	const asked = await h!.say("やめようかな");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"「もう一度絵を描いて」を取りやめますか？",
	);
	expect(h!.todos()).toHaveLength(1);
});

test("the agency's own research is not a work the router is offered: nothing the user says checks, corrects or cancels it", async () => {
	const r = await start({}, { routerModel: DIRECT_ROUTER_MODEL });
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("猫の絵を描いて", "queued");
	// The agent's research stands in the same ledger as the user's work, under the agent's own run.
	const root = "agency:scope:t1";
	await h!.store.write((db) => {
		insertAgencyWork(db, {
			root_id: root,
			conversation_id: "main",
			epoch: 1,
			ticket_id: "t1",
			intent_id: "",
			candidate_id: "",
			question: "猫の絵の描き方を調べてください。",
			toolchain_revision_id: IMAGE.revisionId,
			deadline: Date.now() + 60_000,
			source_refs_json: "[]",
		});
		insertWork(db, {
			id: crypto.randomUUID(),
			conversationId: "main",
			runId: root,
			toolchainId: IMAGE.id,
			toolchainRevisionId: IMAGE.revisionId,
			execution: "task",
			request: "猫の絵の描き方を調べてください。",
			title: "[調べもの] 猫の絵の描き方を調べてください。",
			sourceRef: "execution-1",
			dedupeKey: root,
			createdAt: new Date().toISOString(),
			messageIds: [],
		});
	});
	expect(h!.todos()).toHaveLength(2);
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "調べてみますね。" });
	await h!.say("これも調べてみてもらえますか");
	const offered = names(r.routes.at(-1)!);
	expect(offered).toEqual(
		expect.arrayContaining(["t1.check", "t1.amend", "t1.cancel"]),
	);
	expect(offered.filter((name) => name.startsWith("t2."))).toEqual([]);
	// Both are still there: the research was not touched.
	expect(h!.todos()).toHaveLength(2);
});

test("a doubted hand-over is redone elsewhere: the work is cancelled, the same words go to the other toolchain, and the correction is kept", async () => {
	const r = await start(
		{},
		{ cards: [IMAGE, MUSIC], music: true, routerModel: DIRECT_ROUTER_MODEL },
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.45 }));
	const first = await h!.say("コーヒータイムに合うものを作って", "queued");
	expect(first.announcement).toBe("「画像」に頼みます。");
	expect(trace().set).toEqual([IMAGE.id, MUSIC.id]);
	r.scripts.push(weigh({ [`t1.redirect:${MUSIC.id}`]: 0.95 }));
	const redone = await h!.say("違う、作曲してほしい", "queued");
	expect(redone.announcement).toBe("「作曲」に頼みます。");
	expect(names(r.routes.at(-1)!)).toContain(`t1.redirect:${MUSIC.id}`);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
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

test("the turns before go to the reranker's port, and the user's utterance before the words goes to the toolchain with them", async () => {
	const r = await start();
	r.scripts.push(weigh({}), weigh({ [IMAGE.id]: 0.95 }));
	h!.state.steps.push({ text: "いい色ですね。" });
	await h!.say("夕焼けの色が好き");
	await h!.say("それを絵にして", "queued");
	expect(r.routes.at(-1)!.previousUser).toBe("夕焼けの色が好き");
	expect(r.routes.at(-1)!.previousAgent).toBe("いい色ですね。");
	const request = h!.state.selections.at(-1)!.request as string;
	expect(request).toStartWith("それを絵にして\n直前の発言（");
	expect(request).toContain("夕焼けの色が好き");
	expect(h!.todos()[0]).toMatchObject({ title: "それを絵にして" });
});

test("a correction near the utterance moves the decision, never to a sure one; disagreeing ones apply none and are put out of use; weight 0 turns them off", async () => {
	const r = await start(
		{},
		{ cards: [IMAGE, MUSIC], music: true, routerModel: DIRECT_ROUTER_MODEL },
	);
	const ambiguous = () => weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.45 });
	r.scripts.push(ambiguous());
	expect((await h!.say("夕方に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼みます。",
	);
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
	];
	r.scripts.push(ambiguous());
	expect(
		(await h!.say("夕暮れに合うものを作って", "queued")).announcement,
	).toBe("「作曲」に頼んでみます。");
	// One below the line is not found: nothing moves.
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.9 },
	];
	r.scripts.push(ambiguous());
	expect((await h!.say("お昼に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼みます。",
	);
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
		{ id: "f2", wrongId: MUSIC.id, rightId: IMAGE.id, similarity: 0.99 },
	];
	r.scripts.push(ambiguous());
	expect((await h!.say("朝に合うものを作って", "queued")).announcement).toBe(
		"「画像」に頼みます。",
	);
	expect(h!.state.feedbackStates).toEqual([
		{ id: "f1", state: "conflict" },
		{ id: "f2", state: "conflict" },
	]);
	await h!.close();
	const off = await start(
		{ feedbackWeight: 0 },
		{ cards: [IMAGE, MUSIC], music: true, routerModel: DIRECT_ROUTER_MODEL },
	);
	h!.state.corrections = [
		{ id: "f1", wrongId: IMAGE.id, rightId: MUSIC.id, similarity: 0.99 },
	];
	off.scripts.push(ambiguous());
	expect(
		(await h!.say("夕暮れに合うものを作って", "queued")).announcement,
	).toBe("「画像」に頼みます。");
});

test("with no profile saved there is no router: the turn talks, and nothing is offered or embedded", async () => {
	const r = await start({ profile: undefined });
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("こんにちは");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(r.routes).toEqual([]);
	expect(h!.state.routerEmbeds).toEqual([]);
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.searchSlots).toEqual([]);
});

test("with the router on the user-intent judge is not asked: the package sees the tools and the open confirmations together", async () => {
	const r = await start({}, { cards: [EDIT, INSTANT] });
	let judged = 0;
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
		judgeIntent: async () => {
			judged++;
			throw new Error("unexpected_judge");
		},
	});
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
	await h!.say("壁紙を差し替えて");
	r.scripts.push(weigh({ "c1.decline": 0.95 }));
	const declined = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(declined.id)).toBe(
		"わかりました。やめておきます。",
	);
	expect(names(r.routes.at(-1)!)).toEqual(
		expect.arrayContaining([EDIT.id, INSTANT.id, "c1.approve", "c1.decline"]),
	);
	expect(judged).toBe(0);
});

test("the resources State presents go with a hand-over the router decided, for the agent to pick from", async () => {
	const resources = fakeResources({ [IMAGE.id]: ["image"] });
	const r = await start(
		{},
		{ resources: resources.access, cards: [IMAGE, EDIT] },
	);
	resources.make("image", "image_1", "夜のドライブ");
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	const waiting = await h!.say("夜のドライブの絵を描いて", "queued");
	await h!.finishImage(waiting.id, {
		state: "completed",
		title: "夜のドライブ",
		resourceId: "image_1",
	});
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
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

test("routeStructured: one request with a reference routes the masked utterance; the structure model is the saved resource, at low effort", async () => {
	const resource = "00000000-0000-4000-8000-000000000001";
	const r = await start({
		entry: "routeStructured",
		structureResourceId: resource,
	});
	r.structures.push(
		'{"requests":[{"text":"画像を作って","target":"画像","inputs":["この音楽"],"after":[]}]}',
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	const waiting = await h!.say("この音楽に合う画像を作って", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	// The reranker read the request with its reference masked; the toolchain got the user's words.
	expect(r.routes.map((route) => route.text)).toEqual([
		"これに合う画像を作って",
	]);
	expect(h!.state.selections.at(-1)).toMatchObject({
		request: "この音楽に合う画像を作って",
	});
	const [call] = r.structureCalls;
	expect(call!.control.structuredOutput).toBe(true);
	expect(call!.options).toMatchObject({
		outputSchema: { type: "object", required: ["decision"] },
	});
	expect(call!.messages).toEqual([
		{
			role: "system",
			content: expect.stringContaining(
				"担当の交代自体も今回実施する依頼です。",
			),
		},
		{
			role: "user",
			content: JSON.stringify({
				text: "この音楽に合う画像を作って",
				previousAgent: null,
				pending: [],
				controls: [],
			}),
		},
	]);
	expect(
		call!.messages[0]!.content.startsWith(TURN_STRUCTURE_PROMPT.system),
	).toBe(true);
	expect(call!.control).toMatchObject({
		taskId: "router-structure",
		route: { resourceId: resource },
	});
	expect(call!.options).toMatchObject({ reasoningEffort: "low" });
	expect(h!.state.traces[0]).toMatchObject({
		text: "この音楽に合う画像を作って",
	});
	expect(trace()).toMatchObject({ decided: IMAGE.id, row: 2 });
});

test("routeStructured: no request is the conversation, with nothing scored; requests of two tools never dispatch a partial first job when the pipeline is unavailable", async () => {
	const r = await start(
		{ entry: "routeStructured" },
		{ cards: [IMAGE, MUSIC], music: true },
	);
	r.structures.push('{"requests":[]}');
	h!.state.steps.push({ text: "そうですね。" });
	const talk = await h!.say("今日は疲れた");
	expect(h!.dialogue.answerText(talk.id)).toBe("そうですね。");
	expect(r.routes).toEqual([]);
	expect(r.structureCalls[0]!.control).toMatchObject({ route: "conversation" });
	r.structures.push(
		'{"requests":[{"text":"曲を作って","target":"曲","inputs":[],"after":[]},{"text":"画像も作って","target":"画像","inputs":[],"after":[0]}]}',
	);
	r.scripts.push(weigh({ [MUSIC.id]: 0.95 }), weigh({ [IMAGE.id]: 0.95 }));
	h!.state.steps.push({ text: "パイプラインを利用できません。" });
	const waiting = await h!.say("曲を作って、画像も作って");
	expect(r.routes.map((route) => route.text)).toEqual([
		"曲を作って",
		"画像も作って",
	]);
	expect(h!.dialogue.answerText(waiting.id)).toBe(
		"依頼全体の内容や引継ぎ先を確認できなかったため、今回の作業はまだ実施していません。依頼を確認してから進めます。",
	);
	expect(h!.todos()).toHaveLength(0);
	expect(trace(1).decided).not.toBe(MUSIC.id);
});

test("routeStructured: a failed structure model leaves the entire request unperformed without direct fallback", async () => {
	const r = await start({ entry: "routeStructured" });
	r.structures.push(new Error("cloud_http_529"));
	const stopped = await h!.say("この音楽に合う画像を作って");
	expect(h!.dialogue.answerText(stopped.id)).toContain(
		"今回の作業はまだ実施していません",
	);
	expect(r.routes).toEqual([]);
	expect(h!.todos()).toHaveLength(0);
	expect(h!.state.selections.every((selection) => !selection.toolchainId)).toBe(
		true,
	);
});

test("routeStructured: a mixed multi-job request never falls back to running only its first tool", async () => {
	const r = await start({ entry: "routeStructured" });
	r.structures.push(
		'{"requests":[{"text":"辛い物が好きと覚えて","target":"辛い物が好き","inputs":[],"after":[]},{"text":"画像も作って","target":"画像","inputs":[],"after":[]}]}',
	);
	r.scripts.push(
		weigh({ "memory.request": 0.95 }),
		weigh({ [IMAGE.id]: 0.95 }),
	);
	h!.state.steps.push({ text: "パイプラインを利用できません。" });
	const waiting = await h!.say("辛い物が好きと覚えて、画像も作って");
	expect(h!.dialogue.answerText(waiting.id)).toBe(
		"依頼全体の内容や引継ぎ先を確認できなかったため、今回の作業はまだ実施していません。依頼を確認してから進めます。",
	);
	expect(h!.todos()).toHaveLength(0);
	expect(trace().decided).not.toBe(IMAGE.id);
});

test("invalid B asks with tools disabled and carries the original request into the next A and B", async () => {
	const r = await start();
	const request = "あの資料に合うものを作って";
	const reply = "画像を作って";
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }));
	r.structures.push("invalid JSON");
	h!.state.steps.push({ text: "画像と音楽のどちらを作りますか？" });
	const first = await h!.say(request);
	expect(h!.dialogue.answerText(first.id)).toBe(
		"画像と音楽のどちらを作りますか？",
	);
	expect(h!.state.calls[0]!.tools).toEqual([]);
	expect(h!.state.calls[0]!.messages.at(-1)!.content).toContain(
		'"options":["画像"]',
	);
	expect(h!.state.searchSlots).toEqual([]);
	expect(h!.todos()).toEqual([]);
	expect(trace()).toMatchObject({
		row: 8,
		decided: null,
		error: "structure_failed",
	});

	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }), weigh({ [IMAGE.id]: 0.95 }));
	r.structures.push(
		JSON.stringify({
			requests: [{ text: reply, target: "画像", inputs: [], after: [] }],
		}),
	);
	await h!.say(reply, "queued");
	expect(r.routes.map((call) => call.text)).toEqual([
		request,
		`${request}\n${reply}`,
		reply,
	]);
	expect(JSON.parse(r.structureCalls[1]!.messages[1]!.content).text).toBe(
		reply,
	);
	expect(h!.state.selections.at(-1)!.request).toContain(`${request}\n${reply}`);
	expect(h!.todos()).toHaveLength(1);
});

test("B with no candidate answers without asking or allowing tools", async () => {
	const r = await start();
	const request = "この紙を届けて";
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }), weigh({}));
	r.structures.push(
		JSON.stringify({
			requests: [{ text: request, target: "紙", inputs: [], after: [] }],
		}),
	);
	h!.state.steps.push({
		text: "この依頼に対応できる候補が見つかりませんでした。",
	});
	const first = await h!.say(request);
	expect(h!.dialogue.answerText(first.id)).toContain(
		"候補が見つかりませんでした",
	);
	expect(h!.state.calls[0]!.tools).toEqual([]);
	expect(h!.state.calls[0]!.messages.at(-1)!.content).toContain('"options":[]');
	expect(h!.state.searchSlots).toEqual([]);
	expect(h!.todos()).toEqual([]);

	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("別の絵を描いて", "queued");
	expect(r.routes.at(-1)!.text).toBe("別の絵を描いて");
});

test("B shares the same deadline across structure, embedding and scoring, and drops a late score", async () => {
	const embedSignals: AbortSignal[] = [];
	const r = await start(
		{ structureTimeoutMs: 150 },
		{
			beforeRouterEmbed: async (_texts, signal) => {
				embedSignals.push(signal);
			},
		},
	);
	const request = "この資料に合う画像を作ってください";
	const part = "画像を作ってください";
	const late = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	let scoringSignal: AbortSignal | undefined;
	r.structures.push(
		JSON.stringify({
			requests: [
				{ text: part, target: "画像", inputs: ["この資料"], after: [] },
			],
		}),
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }), async (input, signal) => {
		scoringSignal = signal;
		await late.promise;
		const answer = await weigh({ [IMAGE.id]: 0.95 })(input, signal);
		completed.resolve();
		return answer;
	});
	h!.state.steps.push({ text: "どの画像を作りますか？" });
	const run = await h!.say(request);
	expect(h!.dialogue.answerText(run.id)).toBe("どの画像を作りますか？");
	expect(trace()).toMatchObject({ decided: null, error: "structure_timeout" });
	expect(h!.state.calls[0]!.tools).toEqual([]);
	expect(embedSignals).toHaveLength(2);
	expect(scoringSignal).toBe(r.structureCalls[0]!.signal);
	expect(embedSignals[1]).toBe(scoringSignal);
	expect(scoringSignal?.aborted).toBe(true);
	late.resolve();
	await completed.promise;
	expect(h!.state.searchSlots).toEqual([]);
	expect(h!.todos()).toEqual([]);
});

test("cancelling a turn while B is running prevents a reply and ignores the late structure", async () => {
	const r = await start();
	const request = "画像を作って";
	const started = Promise.withResolvers<void>();
	const late = Promise.withResolvers<string>();
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }));
	r.structures.push(() => {
		started.resolve();
		return late.promise;
	});
	const run = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: request,
	});
	await started.promise;
	await h!.dialogue.cancel(run.id);
	late.resolve(
		JSON.stringify({
			requests: [{ text: request, target: "画像", inputs: [], after: [] }],
		}),
	);
	const ended = await h!.dialogue.waitForTerminal(run.id);
	expect(ended?.status).toBe("cancelled");
	expect(r.structureCalls[0]!.signal.aborted).toBe(true);
	expect(r.routes).toHaveLength(1);
	expect(h!.state.calls).toEqual([]);
	expect(h!.todos()).toEqual([]);
});

test("an unavailable candidate selected by B cannot execute or offer tools to the reply", async () => {
	const cards = [IMAGE, INSTANT];
	const r = await start({}, { cards });
	const request = "画像を作って";
	r.structures.push(
		JSON.stringify({
			requests: [{ text: request, target: "画像", inputs: [], after: [] }],
		}),
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }), async (input, signal) => {
		cards.shift();
		return weigh({ [IMAGE.id]: 0.95 })(input, signal);
	});
	h!.state.steps.push({ text: "画像の担当を利用できませんでした。" });
	const run = await h!.say(request);
	expect(h!.dialogue.answerText(run.id)).toBe(
		"画像の担当を利用できませんでした。",
	);
	expect(trace()).toMatchObject({
		decided: null,
		error: "router_candidate_unavailable",
	});
	expect(h!.state.calls[0]!.tools).toEqual([]);
	expect(h!.todos()).toEqual([]);
});

test("B's explicit clarification uses the existing question without a conversation call", async () => {
	const r = await start();
	r.scripts.push(weigh({ [IMAGE.id]: 0.45 }));
	r.structures.push(
		JSON.stringify({
			clarify: {
				question: "どの画像を作りますか？",
				unhandled: ["画像を作って"],
			},
		}),
	);
	const first = await h!.say("画像を作って");
	expect(h!.dialogue.answerText(first.id)).toContain("どの画像を作りますか？");
	expect(h!.state.calls).toEqual([]);
	expect(h!.todos()).toEqual([]);
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("灯台の絵です", "queued");
	expect(r.routes.at(-1)!.text).toBe("画像を作って\n灯台の絵です");
});
