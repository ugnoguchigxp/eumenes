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
	const started = await startRouter(router, options);
	h = started.h;
	return started;
}
const trace = (index = 0) => traceOf(h!, index);

test("a selected toolchain is validated, handed the user's request and announced by the host", async () => {
	const r = await start();
	h!.state.vector = VECTOR;
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	const waiting = await h!.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	expect(h!.state.calls).toEqual([]);
	expect(r.structureCalls).toEqual([]);
	expect(r.routes).toHaveLength(1);
	expect(h!.todos()[0]).toMatchObject({ title: "猫の絵を描いて" });
	expect(h!.state.routerEmbeds).toEqual(["猫の絵を描いて"]);
	expect(h!.state.searchSlots[0]).toContain(IMAGE.id);
	expect(trace()).toMatchObject({ decided: IMAGE.id, row: 2, query: VECTOR });
	expect(trace().workId).toBe(h!.todos()[0]!.id);
	expect(h!.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		query: VECTOR,
	});
});

test("the conversation leads when the selector returns an empty request list: the turn talks, with one call and no choice", async () => {
	const r = await start();
	r.scripts.push(weigh({}));
	h!.state.steps.push({ text: "いい天気ですね。" });
	const run = await h!.say("いい天気だね");
	expect(h!.dialogue.answerText(run.id)).toBe("いい天気ですね。");
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.calls[0]!.session?.outputSchema).toBeUndefined();
	expect(trace()).toMatchObject({ decided: "conversation.respond", row: 1 });
});

test("A selection to change what exists still requires approval from the host", async () => {
	const r = await start({}, { cards: [EDIT, INSTANT] });
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
	r.structures.push(
		'{"requests":[{"text":"壁紙を差し替えて","target":"壁紙","inputs":[],"after":[]}]}',
	);
	const asked = await h!.say("壁紙を差し替えて");
	expect(h!.dialogue.answerText(asked.id)).toBe(
		"編集に「壁紙を差し替えて」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(trace().row).toBe(4);
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
	expect(candidate?.description).toContain("対象は海辺の灯台");
	expect(h!.todos()).toHaveLength(0);
	expect(h!.archived()).toHaveLength(1);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
});

test("a work is checked, corrected or cancelled by the package's decision: the host's operation, the host's words", async () => {
	const r = await start({}, {});
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("猫の絵を描いて", "queued");
	r.scripts.push(weigh({ "t1.cancel": 0.95 }));
	const cancelled = await h!.say("やっぱりやめる");
	expect(h!.dialogue.answerText(cancelled.id)).toBe("承知しました。");
	expect(names(r.routes.at(-1)!)).toEqual(
		expect.arrayContaining(["t1.check", "t1.amend", "t1.cancel"]),
	);
	expect(h!.archived()[0]).toMatchObject({ outcome: "cancelled" });
	expect(h!.todos()).toHaveLength(0);
});

test("the agency's own research is not a work the router is offered: nothing the user says checks, corrects or cancels it", async () => {
	const r = await start({}, {});
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
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	r.scripts.push(weigh({ [IMAGE.id]: 0.5, [MUSIC.id]: 0.45 }));
	const first = await h!.say("コーヒータイムに合うものを作って", "queued");
	expect(first.announcement).toBe("「画像」に頼みます。");
	expect(trace().set).toEqual(expect.arrayContaining([IMAGE.id, MUSIC.id]));
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

test("the previous user utterance goes to the toolchain with the current request", async () => {
	const r = await start();
	r.scripts.push(weigh({}), weigh({ [IMAGE.id]: 0.95 }));
	h!.state.steps.push({ text: "いい色ですね。" });
	await h!.say("夕焼けの色が好き");
	await h!.say("それを絵にして", "queued");
	expect(r.routes.at(-1)!.previousAgent).toBe("いい色ですね。");
	const request = h!.state.selections.at(-1)!.request as string;
	expect(request).toStartWith("それを絵にして\n直前の発言（");
	expect(request).toContain("夕焼けの色が好き");
	expect(h!.todos()[0]).toMatchObject({ title: "それを絵にして" });
});

test("without a configured decision connection, routing is unavailable: the turn talks, and nothing is offered or embedded", async () => {
	const r = await start();
	h!.state.routerAvailable = false;
	h!.state.steps.push({ text: "はい。" });
	const run = await h!.say("こんにちは");
	expect(h!.dialogue.answerText(run.id)).toBe("はい。");
	expect(r.routes).toEqual([]);
	expect(h!.state.routerEmbeds).toEqual([]);
	expect(h!.state.calls).toHaveLength(1);
	expect(h!.state.searchSlots).toEqual([]);
});

test("with the router on the user-intent judge is not asked: the selector sees the open confirmations", async () => {
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
		expect.arrayContaining(["c1.approve", "c1.decline"]),
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

test("a single request masks the resource for retrieval and retains the original text for handover", async () => {
	const resource = "00000000-0000-4000-8000-000000000001";
	const r = await start({
		structureResourceId: resource,
	});
	r.structures.push(
		'{"requests":[{"text":"画像を作って","target":"画像","inputs":["この音楽"],"after":[]}]}',
	);
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	const waiting = await h!.say("この音楽に合う画像を作って", "queued");
	expect(waiting.announcement).toBe("「画像」に頼みます。");
	// The selector saw the masked reference; the toolchain got the user's words.
	expect(h!.state.routerEmbeds).toEqual(["これに合う画像を作って"]);
	expect(h!.state.selections.at(-1)).toMatchObject({
		request: "この音楽に合う画像を作って",
	});
	const [call] = r.structureCalls;

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

	expect(h!.state.traces[0]).toMatchObject({
		text: "この音楽に合う画像を作って",
	});
	expect(trace()).toMatchObject({ decided: IMAGE.id, row: 2 });
});

test("conversation skips search and an unavailable planner prevents partial execution", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC], music: true });
	r.structures.push('{"requests":[]}');
	h!.state.steps.push({ text: "そうですね。" });
	const talk = await h!.say("今日は疲れた");
	expect(h!.dialogue.answerText(talk.id)).toBe("そうですね。");
	expect(r.routes).toEqual([]);
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
		"パイプラインを利用できません。",
	);
	expect(h!.todos()).toHaveLength(0);
	expect(trace(1).decided).not.toBe(MUSIC.id);
});

test("A failed structure model leaves the entire request unperformed without direct fallback", async () => {
	const r = await start({});
	r.structures.push(new Error("cloud_http_529"));
	h!.state.steps.push({ text: "画像はまだ作っていません。" });
	const stopped = await h!.say("この音楽に合う画像を作って");
	expect(h!.dialogue.answerText(stopped.id)).toBe("画像はまだ作っていません。");
	expect(r.routes).toEqual([]);
	expect(h!.todos()).toHaveLength(0);
	expect(h!.state.selections.every((selection) => !selection.toolchainId)).toBe(
		true,
	);
});

test("a reply after invalid routing cannot delegate, approve, or cancel", async () => {
	const r = await start({}, { cards: [IMAGE, EDIT] });
	r.scripts.push(weigh({ [IMAGE.id]: 0.95 }));
	await h!.say("猫の絵を描いて", "queued");
	r.scripts.push(weigh({ [EDIT.id]: 0.95 }));
	await h!.say("壁紙を差し替えて");
	const confirmations = () =>
		h!.store.read((db) =>
			db
				.query("SELECT id, used_at, superseded_at FROM dialogue_confirmations")
				.all(),
		);
	const pending = confirmations();
	expect(pending).toHaveLength(1);
	expect(pending[0]).toMatchObject({ used_at: null, superseded_at: null });
	const [work] = h!.todos();
	expect(work).toBeDefined();
	for (const [request, name, args] of [
		[
			"別の画像も頼んで",
			"delegate",
			{ toolchain: IMAGE.id, request: "別の画像", mode: "execute" },
		],
		["壁紙の変更を承認します", "approve", { confirmation: "c1" }],
		["猫の絵は取り消して", "work", { todo: "t1", operation: "cancel" }],
	] as const) {
		r.structures.push("{}");
		h!.state.steps.push(
			{ calls: [{ name, args }] },
			{ text: "作業はまだ実施していません。" },
		);
		const run = await h!.say(request);
		expect(h!.dialogue.answerText(run.id)).toBe("作業はまだ実施していません。");
		expect(h!.state.calls.at(-2)!.tools).toEqual(["read_history", "read_runs"]);
		expect(h!.state.calls.at(-1)!.messages.at(-1)!.content).toContain(
			"invalid_tool_call",
		);
	}
	expect(confirmations()).toEqual(pending);
	expect(h!.todos()).toEqual([work!]);
	expect(h!.archived()).toEqual([]);
});

test("A mixed multi-job request never falls back to running only its first tool", async () => {
	const r = await start({});
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
		"パイプラインを利用できません。",
	);
	expect(h!.todos()).toHaveLength(0);
	expect(h!.state.calls[0]!.tools).toEqual([]);
	expect(h!.state.stewardRequests).toEqual([]);
	expect(trace().decided).not.toBe(IMAGE.id);
});

test("A valid no-match result answers without asking or allowing tools", async () => {
	const r = await start();
	const request = "この紙を届けて";
	r.scripts.push(weigh({}));
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

test("structure, embedding and selection share a deadline and ignore a late selection", async () => {
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
	r.scripts.push(async (input, signal) => {
		scoringSignal = signal;
		await late.promise;
		const answer = await weigh({ [IMAGE.id]: 0.95 })(input, signal);
		completed.resolve();
		return answer;
	});
	h!.state.steps.push({
		text: "画像はまだ作っていません。",
	});
	const run = await h!.say(request);
	expect(h!.dialogue.answerText(run.id)).toBe("画像はまだ作っていません。");
	expect(trace()).toMatchObject({ decided: null, error: "timeout" });
	expect(h!.state.calls).toHaveLength(1);
	expect(embedSignals).toHaveLength(1);
	expect(scoringSignal).toBe(r.structureCalls[0]!.signal);
	expect(embedSignals[0]).toBe(scoringSignal);
	expect(scoringSignal?.aborted).toBe(true);
	late.resolve();
	await completed.promise;
	expect(h!.state.searchSlots).toEqual([]);
	expect(h!.todos()).toEqual([]);
});

test("cancelling a turn while structure is running prevents a reply and ignores the late structure", async () => {
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
	expect(r.routes).toHaveLength(0);
	expect(h!.state.calls).toEqual([]);
	expect(h!.todos()).toEqual([]);
});

test("a candidate returned under a different request index does not start work", async () => {
	const r = await start({}, { cards: [IMAGE, MUSIC] });
	const request = "猫の絵を描いて、曲も作って";
	r.structures.push(
		JSON.stringify({
			requests: [
				{ text: "猫の絵を描いて", target: "猫の絵", inputs: [], after: [] },
				{ text: "曲も作って", target: "曲", inputs: [], after: [] },
			],
		}),
	);
	const port = h!.larm.selectRouter!;
	let selections = 0;
	h!.larm.selectRouter = async (prompt, signal) => {
		if (prompt.version === TURN_STRUCTURE_PROMPT.version)
			return port(prompt, signal);
		selections++;
		const asked = JSON.parse(prompt.user) as {
			requests: Array<{ index: string; candidates: Array<{ id: string }> }>;
		};
		const [first, second] = asked.requests;
		expect(first?.candidates.length).toBeGreaterThan(0);
		expect(second?.candidates.length).toBeGreaterThan(0);
		expect(second?.index).not.toBe(first?.index);
		const foreign = first!.candidates.find(
			(candidate) =>
				!second!.candidates.some((item) => item.id === candidate.id),
		);
		expect(foreign?.id).toBeTruthy();
		return JSON.stringify({
			selections: {
				[first!.index]: { kind: "candidate", id: foreign!.id },
				[second!.index]: { kind: "candidate", id: foreign!.id },
			},
		});
	};
	h!.state.steps.push({ text: "まだ頼んでいません。" });
	const run = await h!.say(request);
	expect(h!.dialogue.answerText(run.id)).toBe("まだ頼んでいません。");
	expect(selections).toBe(1);
	expect(trace()).toMatchObject({
		decided: null,
		error: "route_selection_invalid_response",
	});
	expect(h!.todos()).toEqual([]);
	expect(h!.archived()).toEqual([]);
	expect(h!.state.selections.every((selection) => !selection.toolchainId)).toBe(
		true,
	);
	expect(h!.state.stewardRequests).toEqual([]);
	expect(h!.state.images.size).toBe(0);
	expect(h!.state.calls).toHaveLength(1);
	expect(
		h!.state.calls[0]!.tools.every((name) => name.startsWith("read_")),
	).toBe(true);
	expect(h!.state.calls[0]!.tools.length).toBeGreaterThan(0);
});

test("an unavailable candidate selected by the model cannot execute, and the reply only gets reads", async () => {
	const cards = [IMAGE, INSTANT];
	const r = await start({}, { cards });
	const request = "画像を作って";
	r.structures.push(
		JSON.stringify({
			requests: [{ text: request, target: "画像", inputs: [], after: [] }],
		}),
	);
	r.scripts.push(async (input, signal) => {
		cards.shift();
		return weigh({ [IMAGE.id]: 0.95 })(input, signal);
	});
	h!.state.steps.push({
		text: "画像はまだ作っていません。",
	});
	const run = await h!.say(request);
	expect(h!.dialogue.answerText(run.id)).toBe("画像はまだ作っていません。");
	expect(trace()).toMatchObject({
		decided: null,
		error: "router_candidate_unavailable",
	});
	expect(h!.state.calls[0]!.tools).toEqual(["read_history", "read_runs"]);
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
