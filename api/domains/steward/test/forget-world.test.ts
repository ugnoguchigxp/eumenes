import { afterEach, expect, test } from "bun:test";
import { CONVERSATION_DEFAULT_SCOPE } from "../../conversation";
import {
	GOALS_ACCESS,
	setupSteward,
	topicEmbed,
	type StewardHarness,
} from "./steward.fixture";
import { createFakeWorld, type FakeWorld } from "./world.fake";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	let fake!: FakeWorld;
	const h = await setupSteward({
		embed: topicEmbed,
		goals: true,
		async world({ store, conversation, kick }) {
			const made = await createFakeWorld(store, conversation, kick);
			fake = made.fake;
			return made.world;
		},
	});
	harnesses.push(h);
	return { h, fake };
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const judged = (world: boolean, goals: boolean) => ({
	...empty,
	route: [
		{ event: "e1", world, goals },
		{ event: "e2", world, goals },
	],
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
const goalChange = (over: Record<string, unknown>) => ({
	op: "adopt",
	ref: null,
	text: null,
	priority: null,
	evidence: "e1",
	entities: [],
	request: null,
	...over,
});
const claimAnswer = {
	entities: [],
	claims: [
		{
			op: "assert",
			ref: null,
			subject: "w1",
			predicate: "available",
			value: {
				type: "boolean",
				text: null,
				flag: true,
				number: null,
				unit: null,
			},
			relation: null,
			evidence: "e1",
			origin: "user_report",
			validFrom: null,
			validUntil: null,
		},
	],
	changed: true,
};
const rows = (h: StewardHarness, sql: string, ...args: string[]) =>
	h.store.read((db) => db.query(sql).all(...args)) as Array<
		Record<string, unknown>
	>;
const goalTexts = (h: StewardHarness) =>
	rows(h, "SELECT desired_state AS text FROM goals_ledger ORDER BY rowid").map(
		(r) => r.text,
	);

/** World's view as the model is shown it: the entity w1, its claim k1. */
function showWorld(fake: FakeWorld, claimId = "claim-1") {
	fake.view = {
		refs: {
			w1: { kind: "entity", id: "ent-1" },
			k1: { kind: "claim", id: claimId, entityIds: ["ent-1"] },
		},
		entities: [{ ref: "w1", name: "音声サービス", aliases: [] }],
		claims: [{ ref: "k1", text: "音声サービス の available: はい" }],
	};
}

/**
 * The state the forget tests start from: a world claim (claim-1) learned from E1, a goal linked to the entity from
 * E2 together with a sibling goal from the same message, and an unrelated goal from E3.
 */
async function learn(h: StewardHarness, fake: FakeWorld) {
	showWorld(fake);
	h.inference.script(
		"curate-memory",
		judged(true, false),
		judged(false, true),
		judged(false, true),
	);
	h.inference.script("curate-world", claimAnswer);
	h.inference.script(
		"curate-goals",
		{
			goals: [
				goalChange({ text: "音声サービスを速くしたい", entities: ["w1"] }),
				goalChange({ op: "propose", text: "音声のキャッシュを検討する" }),
			],
		},
		{ goals: [goalChange({ op: "propose", text: "散歩を習慣にする" })] },
	);
	const e1 = await h.run({
		user: "音声サービスは9月から使える",
		answer: "了解です",
		end: "completed",
	});
	await h.drain();
	await fake.receiveAll([e1.inputMessageId, e1.answerMessageId!]);
	await h.drain();
	fake.evidence.set("claim-1", [e1.inputMessageId]);
	fake.evidence.set("ent-1", [e1.inputMessageId]);
	const e2 = await h.run({
		user: "音声サービスを速くしたい",
		answer: "検討します",
		end: "completed",
	});
	await h.drain();
	const e3 = await h.run({
		user: "散歩を習慣にしたい",
		answer: "いいですね",
		end: "completed",
	});
	await h.drain();
	expect(goalTexts(h)).toEqual([
		"音声サービスを速くしたい",
		"音声のキャッシュを検討する",
		"散歩を習慣にする",
	]);
	expect(fake.events().map((e) => e.state)).toEqual(["applied", "applied"]);
	return { e1, e2, e3 };
}

test("naming a world entity and claim forgets them, their evidence, the goals tied to the entity, and nothing else of the same message", async () => {
	const { h, fake } = await setup();
	const { e1, e2, e3 } = await learn(h, fake);
	const before = h.steward
		.decisions("c1")
		.filter((d) => d.step === "curate-world");
	expect(before).toHaveLength(1);

	h.inference.script("curate-memory", (data) => {
		// World's entities and claims and the goals are shown as refs the request may name.
		expect(data.worldEntities).toEqual([
			{ ref: "w1", name: "音声サービス", aliases: [] },
		]);
		expect(data.worldClaims).toEqual([
			{ ref: "k1", text: "音声サービス の available: はい" },
		]);
		expect((data.goals as unknown[]).length).toBe(3);
		return { ...empty, resolve: [resolve({ refs: ["w1", "k1"] })], route: [] };
	});
	await h.run({
		user: "音声サービスのことは全部忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービス" }],
	});
	await h.drain();

	// World: the entity is taken as a forget, and the claim about it goes with it (not named twice); the evidence was
	// read BEFORE (F7).
	expect(fake.callsOf("forgetClaims")[0]!.detail).toEqual([]);
	expect(fake.callsOf("forgetEntities")[0]!.detail).toEqual(["ent-1"]);
	expect(fake.callsOf("evidence")[0]!.detail).toEqual({
		claims: [],
		entities: ["ent-1"],
	});
	// The goal tied to the entity went with its history and provenance; the sibling of the same message stays (F8).
	expect(goalTexts(h)).toEqual([
		"音声のキャッシュを検討する",
		"散歩を習慣にする",
	]);
	expect(
		rows(
			h,
			"SELECT COUNT(*) AS n FROM goals_history WHERE goal_id NOT IN (SELECT id FROM goals_ledger)",
		),
	).toEqual([{ n: 0 }]);
	expect(rows(h, "SELECT COUNT(*) AS n FROM goals_entity")).toEqual([{ n: 0 }]);
	// The evidence of the world claim and the goal's message went on the exclusion ledger, with their partners (F7, F10).
	const blocked = h.memory.blockedMessageIds([
		e1.inputMessageId,
		e1.answerMessageId!,
		e2.inputMessageId,
		e2.answerMessageId!,
		e3.inputMessageId,
	]);
	expect([...blocked].sort()).toEqual(
		[
			e1.inputMessageId,
			e1.answerMessageId!,
			e2.inputMessageId,
			e2.answerMessageId!,
		].sort(),
	);
	// Whatever memory blocked also leaves World as a forgotten source (F1).
	const source = fake.callsOf("sourceForget")[0]!.detail as string[];
	expect(source).toContain(e1.inputMessageId);
	expect(source).toContain(e2.inputMessageId);
	// The World forgets are advanced after the transaction committed: the entity and the source.
	expect(fake.resumed.sort()).toEqual([...fake.forgetIds].sort());
	expect(fake.resumed).toHaveLength(2);
	// The decisions that stood on the forgotten claim, goal and messages are gone, and so is the request's text.
	const after = JSON.stringify(h.steward.decisions("c1"));
	expect(after).not.toContain("音声サービスを速くしたい");
	expect(
		h.steward.decisions("c1").filter((d) => d.step === "curate-world"),
	).toEqual([]);
	expect(h.inbox()).toMatchObject([{ state: "done", what: "" }]);
	// The unrelated goal's decision stays.
	expect(h.steward.decisions("c1").some((d) => d.step === "curate-goals")).toBe(
		true,
	);
});

test("claims about a chosen entity and the goals tied to it are not counted again, and an unrelated goal is left alone", async () => {
	const { h, fake } = await setup();
	await learn(h, fake);
	// Seven refs in all: the entity, four claims about it, a goal tied to it, and a goal about something else.
	for (const n of [2, 3, 4]) {
		fake.view!.refs[`k${n}`] = {
			kind: "claim",
			id: `claim-${n}`,
			entityIds: ["ent-1"],
		};
		fake.view!.claims.push({
			ref: `k${n}`,
			text: `音声サービス の 項目${n}: はい`,
		});
	}
	h.inference.script("curate-memory", (data) => {
		const goal = (text: string) =>
			(data.goals as Array<{ ref: string; text: string }>).find((g) =>
				g.text.includes(text),
			)!.ref;
		return {
			...empty,
			resolve: [
				resolve({
					refs: [
						"w1",
						"k1",
						"k2",
						"k3",
						"k4",
						goal("速くしたい"),
						goal("散歩"),
					],
				}),
			],
			route: [],
		};
	});
	await h.run({
		user: "音声サービスのことは全部忘れたい",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービスのことは全部忘れたい" }],
	});
	await h.drain();
	// The entity goes; the claims and the tied goal go with it, and are not asked for separately.
	expect(fake.callsOf("forgetEntities")[0]!.detail).toEqual(["ent-1"]);
	expect(
		fake.callsOf("forgetClaims").flatMap((c) => c.detail as string[]),
	).toEqual([]);
	// The goal about walking shares nothing with the request: untouched, like the goal of the cache.
	expect(goalTexts(h)).toEqual([
		"音声のキャッシュを検討する",
		"散歩を習慣にする",
	]);
	expect(h.inbox()).toMatchObject([{ state: "done", what: "" }]);
});

test("a goal named in a request is forgotten with its message; the goal layer epoch moves", async () => {
	const { h, fake } = await setup();
	const { e2, e3 } = await learn(h, fake);
	const epoch = () => rows(h, "SELECT epoch FROM goals_scope_epochs");
	const epochBefore = epoch();
	h.inference.script("curate-memory", (data) => {
		const goals = data.goals as Array<{ ref: string; text: string }>;
		const target = goals.find((g) => g.text === "音声サービスを速くしたい")!;
		return { ...empty, resolve: [resolve({ refs: [target.ref] })], route: [] };
	});
	await h.run({
		user: "速くしたいという目標は忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "速くしたいという目標" }],
	});
	await h.drain();
	expect(goalTexts(h)).toEqual([
		"音声のキャッシュを検討する",
		"散歩を習慣にする",
	]);
	expect(
		h.memory.blockedMessageIds([e2.inputMessageId, e3.inputMessageId]),
	).toEqual(new Set([e2.inputMessageId]));
	// An adopted goal left: the layer built from goals is invalid (immediate change for answers).
	expect(epoch()).not.toEqual(epochBefore);
	// No world claim was asked for: World's intake was not touched except for the blocked sources.
	expect(fake.callsOf("forgetClaims")).toHaveLength(0);
	expect(fake.callsOf("sourceForget")).toHaveLength(1);
});

test("one request names at most five things in all, across memory, world and goals; over the limit nothing is forgotten", async () => {
	const { h, fake } = await setup();
	await learn(h, fake);
	// Six refs: two world claims and four goals (the entity is not named, so nothing is subsumed).
	fake.view!.refs.k2 = { kind: "claim", id: "claim-2" };
	fake.view!.claims.push({ ref: "k2", text: "音声サービス の speed: 速い" });
	const extra = await h.say("user", "もう一つの目標");
	await h.goals!.propose(GOALS_ACCESS, {
		scopeKey: CONVERSATION_DEFAULT_SCOPE,
		desiredState: "四つ目の目標",
		source: { namespace: "conversation", kind: "message", id: extra },
		sourceMessageIds: [extra],
	});
	h.inference.script("curate-memory", (data) => {
		const goals = (data.goals as Array<{ ref: string }>).map((g) => g.ref);
		return {
			...empty,
			resolve: [resolve({ refs: ["k1", "k2", ...goals] })],
			route: [],
		};
	});
	await h.run({
		user: "全部忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービスと散歩と目標" }],
	});
	await h.drain();
	expect(goalTexts(h)).toHaveLength(4);
	expect(fake.callsOf("forgetClaims")).toHaveLength(0);
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "forget_limit" },
	]);
	expect(
		h.memory.blockedMessageIds(
			rows(h, "SELECT message_id AS id FROM goals_source").map(
				(r) => r.id as string,
			),
		).size,
	).toBe(0);
});

test("when World can not be read the forget is refused whole, and the request says so", async () => {
	const { h, fake } = await setup();
	await learn(h, fake);
	fake.unavailable = true;
	h.inference.script("curate-memory", {
		...empty,
		resolve: [resolve({ refs: ["w1", "k1"] })],
		route: [],
	});
	await h.run({
		user: "音声サービスは忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービス" }],
	});
	await h.drain();
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "world_unavailable" },
	]);
	expect(goalTexts(h)).toHaveLength(3);
	expect(fake.callsOf("forgetClaims")).toHaveLength(0);
	expect(fake.callsOf("sourceForget")).toHaveLength(0);
	expect(fake.resumed).toEqual([]);
});

test("when the evidence of the claims can be read only in part the forget is refused whole, and the user is told to ask again", async () => {
	const { h, fake } = await setup();
	await learn(h, fake);
	fake.evidenceIncomplete = true;
	h.inference.script("curate-memory", {
		...empty,
		resolve: [resolve({ refs: ["w1", "k1"] })],
		route: [],
	});
	await h.run({
		user: "音声サービスは忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービス" }],
	});
	await h.drain();
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "evidence_incomplete" },
	]);
	expect(goalTexts(h)).toHaveLength(3);
	expect(fake.callsOf("forgetClaims")).toHaveLength(0);
	expect(fake.callsOf("forgetEntities")).toHaveLength(0);
	expect(fake.callsOf("sourceForget")).toHaveLength(0);
	expect(fake.resumed).toEqual([]);
	const notices = h.notices();
	expect(notices.some((t) => t.includes("もう一度お願いします"))).toBe(true);
	expect(notices.some((t) => /evidence|incomplete/.test(t))).toBe(false);
});

test("a memory forget also takes the blocked messages out of World as sources", async () => {
	const { h, fake } = await setup();
	const address = {
		kind: "personal_fact",
		key: "address",
		text: "住所は東京都千代田区",
		evidence: "e1",
		quote: null,
		validFrom: null,
		validUntil: null,
		negated: false,
	};
	h.inference.script("curate-memory", {
		...empty,
		remember: [address],
		route: [],
	});
	const first = await h.run({
		user: "私の住所は東京都千代田区です",
		answer: "承知しました",
		end: "completed",
	});
	await h.drain();
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			resolve: [resolve({ refs: [ref], alsoIn: ["xc1"] })],
			route: [],
		};
	});
	await h.run({
		user: "住所を忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所" }],
	});
	await h.drain();
	const source = fake.callsOf("sourceForget")[0]!.detail as string[];
	expect(source.sort()).toEqual(
		[first.inputMessageId, first.answerMessageId!].sort(),
	);
	expect(fake.resumed).toEqual(["sb-1"]);
});
