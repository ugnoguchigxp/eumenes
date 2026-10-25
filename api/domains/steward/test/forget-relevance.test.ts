import { afterEach, expect, test } from "bun:test";
import { contentUnits, mentions, relatedToRequest } from "../service/relevance";
import { NOTHING_TO_FORGET_NOTICE } from "../service/notices";
import {
	setupSteward,
	topicEmbed,
	type StewardHarness,
} from "./steward.fixture";
import { createFakeWorld, type FakeWorld } from "./world.fake";

// A forget names only what has to do with the request, and a request is answered only by its own label: the live
// acceptance (2026-10-15) showed the model answering `request: "forget"` with two unrelated memories.

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup(world = false) {
	let fake: FakeWorld | undefined;
	const h = await setupSteward({
		embed: topicEmbed,
		...(world
			? {
					async world({ store, conversation, kick }) {
						const made = await createFakeWorld(store, conversation, kick);
						fake = made.fake;
						return made.world;
					},
				}
			: {}),
	});
	harnesses.push(h);
	return { h, fake };
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const item = (key: string, text: string) => ({
	kind: "preference",
	key,
	text,
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
});
const resolve = (over: Record<string, unknown>) => ({
	request: "r1",
	action: "forget",
	refs: [],
	alsoIn: [],
	text: null,
	kind: null,
	key: null,
	...over,
});
const refOf = (data: Record<string, unknown>, text: string) =>
	(data.longTerm as Array<{ ref: string; text: string }>).find((e) =>
		e.text.includes(text),
	)!.ref;
const noticeTexts = (h: StewardHarness) => h.notices();
const resultsOf = (h: StewardHarness) =>
	h.steward
		.decisions("c1")
		.filter((d) => d.step === "curate-memory")
		.flatMap((d) => (d.results as unknown[] | null) ?? []);
const keys = (h: StewardHarness) =>
	h.memory
		.list()
		.map((i) => i.semanticKey)
		.sort();

/** The two memories of the live acceptance: spicy food and the cycling hobby. */
async function learn(h: StewardHarness) {
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			item("food.spicy", "辛いものが苦手である"),
			item("hobby.cycling", "週末に鎌倉へ自転車で出かけるのが趣味である"),
		],
	});
	const first = await h.run({
		user: "辛いものが苦手です。週末は鎌倉へ自転車で出かけるのが趣味です。",
		answer: "承知しました",
		end: "completed",
	});
	await h.drain();
	expect(keys(h)).toEqual(["food.spicy", "hobby.cycling"]);
	return first;
}

test("the live case: two memories unrelated to the request are not forgotten, and the request ends with a plain notice", async () => {
	const { h } = await setup();
	await learn(h);
	h.inference.script("curate-memory", (data) => ({
		...empty,
		resolve: [
			resolve({
				refs: [refOf(data, "辛い"), refOf(data, "鎌倉")],
				alsoIn: ["e1"],
				text: "辛いものが苦手であることを忘れる。",
			}),
		],
	}));
	const asked = await h.run({
		user: "Eumenes と LARM のことは全部忘れてください。",
		end: "completed",
		requests: [{ kind: "forget", what: "Eumenes と LARM について" }],
	});
	await h.drain();
	expect(keys(h)).toEqual(["food.spicy", "hobby.cycling"]);
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "unrelated_target", what: "" },
	]);
	const notices = noticeTexts(h);
	expect(notices).toContain(NOTHING_TO_FORGET_NOTICE);
	expect(notices.join("")).not.toMatch(/unrelated|nothing_to|_target/);
	// The decision says what was left out.
	expect(resultsOf(h)).toContainEqual({
		section: "resolve",
		index: 0,
		status: "rejected",
		code: "unrelated_target",
	});
	// Nothing of the conversation was blocked: the exchange of the request is not a thing to forget by itself.
	expect(
		h.memory.blockedMessageIds([asked.inputMessageId, asked.answerMessageId!])
			.size,
	).toBe(0);
});

test("a correct forget still works, and a related and an unrelated ref in one answer forget only the related one", async () => {
	const { h } = await setup();
	await learn(h);
	h.inference.script("curate-memory", (data) => ({
		...empty,
		resolve: [
			resolve({
				refs: [refOf(data, "辛い"), refOf(data, "鎌倉")],
				alsoIn: ["e1"],
			}),
		],
	}));
	await h.run({
		user: "辛いものの話は忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "辛いものが苦手なこと" }],
	});
	await h.drain();
	expect(keys(h)).toEqual(["hobby.cycling"]);
	expect(h.inbox()).toMatchObject([{ state: "done", what: "" }]);
	expect(noticeTexts(h)).toContain("忘れる依頼を実行しました。");
});

test("an earlier exchange the request has nothing to do with is not blocked by alsoIn", async () => {
	const { h } = await setup();
	const first = await learn(h);
	// Found by meaning through the answer, which mentions the spicy food; the user's words are about something else.
	h.inference.script("curate-memory", empty);
	const other = await h.run({
		user: "好きな食べ物は何ですか",
		answer: "辛いものがお好きなのですね",
		end: "completed",
	});
	await h.drain();
	h.inference.script("curate-memory", (data) => {
		const candidates = data.candidates as Array<{ id: string; user: string }>;
		expect(candidates).toHaveLength(2);
		return {
			...empty,
			resolve: [
				resolve({
					refs: [refOf(data, "辛い")],
					alsoIn: candidates.map((c) => c.id),
				}),
			],
		};
	});
	await h.run({
		user: "辛いものは忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "辛いもの" }],
	});
	await h.drain();
	const blocked = h.memory.blockedMessageIds([
		first.inputMessageId,
		first.answerMessageId!,
		other.inputMessageId,
		other.answerMessageId!,
	]);
	expect([...blocked].sort()).toEqual(
		[first.inputMessageId, first.answerMessageId!].sort(),
	);
	expect(keys(h)).toEqual(["hobby.cycling"]);
});

test("a request is answered only by its own label: the kind is never a fallback", async () => {
	const { h } = await setup();
	await learn(h);
	h.inference.script("curate-memory", (data) => ({
		...empty,
		resolve: [
			// `forget` is the kind of the request, not its label.
			resolve({ request: "forget", refs: [refOf(data, "辛い")] }),
		],
	}));
	await h.run({
		user: "辛いものを忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "辛いもの" }],
	});
	await h.drain();
	expect(keys(h)).toEqual(["food.spicy", "hobby.cycling"]);
	expect(resultsOf(h)).toContainEqual({
		section: "resolve",
		index: 0,
		status: "rejected",
		code: "unknown_request",
	});
	// The request was not answered by that element: it counts as a failure, and nothing was forgotten for it.
	expect(h.inbox()[0]!.failures).toBeGreaterThan(0);
});

test("the strict schema of curate-memory allows only the request labels of the unit", async () => {
	const { h } = await setup();
	await learn(h);
	h.inference.script("curate-memory", empty);
	await h.run({
		user: "辛いものを忘れて、あと鎌倉のことも",
		end: "completed",
		requests: [
			{ kind: "forget", what: "辛いもの" },
			{ kind: "forget", what: "鎌倉" },
		],
	});
	await h.drain();
	const requestEnum = (schema: unknown) =>
		(
			schema as {
				properties: {
					resolve: {
						items: { properties: { request: { enum: string[] } } };
					};
				};
			}
		).properties.resolve.items.properties.request.enum;
	const calls = h.inference.callsOf("curate-memory");
	// The first unit had no request: only the empty label, which the host drops.
	expect(requestEnum(calls[0]!.schema)).toEqual([""]);
	expect(requestEnum(calls[1]!.schema)).toEqual(["r1", "r2"]);
});

test("a World entity named in the request is forgotten", async () => {
	const { h, fake } = await setup(true);
	fake!.view = {
		refs: {
			w1: { kind: "entity", id: "ent-eumenes" },
			w2: { kind: "entity", id: "ent-larm" },
			w3: { kind: "entity", id: "ent-voice" },
		},
		entities: [
			{ ref: "w1", name: "Eumenes", aliases: [] },
			{ ref: "w2", name: "LARM", aliases: ["ラーム"] },
			{ ref: "w3", name: "音声サービス", aliases: [] },
		],
		claims: [],
	};
	h.inference.script("curate-memory", {
		...empty,
		route: [
			{ event: "e1", world: false, goals: false },
			{ event: "e2", world: false, goals: false },
		],
	});
	await h.run({
		user: "LARM を使っています",
		answer: "はい",
		end: "completed",
	});
	await h.drain();

	h.inference.script("curate-memory", {
		...empty,
		// The model also names the voice service, which the request does not mention.
		resolve: [resolve({ refs: ["w1", "w2", "w3"] })],
		route: [],
	});
	await h.run({
		user: "Eumenes と larm のことは全部忘れてください。",
		end: "completed",
		requests: [{ kind: "forget", what: "Eumenes と larm について" }],
	});
	await h.drain();
	expect(
		(fake!.callsOf("forgetEntities")[0]!.detail as string[]).sort(),
	).toEqual(["ent-eumenes", "ent-larm"]);
	expect(h.inbox()).toMatchObject([{ state: "done", what: "" }]);
});

test("relevance is by name or by shared content, case-insensitive", () => {
	expect(mentions("Eumenes と LARM について", "larm")).toBe(true);
	expect(mentions("Ｌａｒｍのこと", "LARM")).toBe(true);
	// An ASCII name is found as a whole word.
	expect(mentions("maintain", "ai")).toBe(false);
	expect(mentions("音声サービスについて", "音声サービス")).toBe(true);
	expect(mentions("x", "x")).toBe(false);
	expect(
		relatedToRequest("辛いものが苦手なこと", ["辛いものが苦手である"]),
	).toBe(true);
	expect(
		relatedToRequest("Eumenes と LARM について", [
			"週末に鎌倉へ自転車で出かけるのが趣味である",
		]),
	).toBe(false);
	expect(relatedToRequest("Eumenes", ["LARM depends_on Eumenes"])).toBe(true);
	expect(relatedToRequest("Eumenes", ["LARM depends_on 音声サービス"])).toBe(
		false,
	);
	// Particles cut the text: no bigram spans them.
	expect([...contentUnits("鎌倉への旅")]).toEqual(["鎌倉"]);
	// Grammar is not content: shared hiragana pairs, and a lone ideograph, do not relate two texts.
	expect(
		relatedToRequest("Eumenes と LARM のことを忘れたい", [
			"音声応答の遅延を半分にしたい",
		]),
	).toBe(false);
	expect(relatedToRequest("猫のこと", ["猫が好き"])).toBe(false);
	expect(relatedToRequest("", ["猫が好き"])).toBe(false);
});
