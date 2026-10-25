import { afterEach, expect, test } from "bun:test";
import { CONVERSATION_DEFAULT_SCOPE } from "../../conversation";
import {
	GOALS_ACCESS,
	setupSteward,
	type StewardHarness,
} from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward({ goals: true });
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const judged = (goals: boolean) => ({
	...empty,
	route: [
		{ event: "e1", world: false, goals },
		{ event: "e2", world: false, goals },
	],
});
const change = (over: Record<string, unknown>) => ({
	op: "adopt",
	ref: null,
	text: null,
	priority: null,
	evidence: "e1",
	entities: [],
	request: null,
	...over,
});
const rows = (h: StewardHarness, sql: string, ...args: string[]) =>
	h.store.read((db) => db.query(sql).all(...args)) as Array<
		Record<string, unknown>
	>;
const goalsOf = (h: StewardHarness) =>
	rows(
		h,
		"SELECT id, status, desired_state AS text, priority, revision FROM goals_ledger ORDER BY created_at, rowid",
	);
const source = (id: string) => ({
	namespace: "conversation",
	kind: "message",
	id,
});

test("a stated goal is adopted and an inferred one is proposed, both standing on the user's message; the chain goes on", async () => {
	const h = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-goals", {
		goals: [
			change({
				op: "adopt",
				text: "音声応答の遅延を減らしたい",
				priority: "high",
			}),
			change({ op: "propose", text: "キャッシュを検討する", priority: null }),
		],
	});
	const ex = await h.run({
		user: "音声応答の遅延を減らしたい",
		answer: "遅延の原因を調べましょう",
		end: "completed",
	});
	await h.drain();
	expect(goalsOf(h)).toMatchObject([
		{ status: "adopted", text: "音声応答の遅延を減らしたい", priority: 80 },
		{ status: "proposed", text: "キャッシュを検討する", priority: 50 },
	]);
	// The provenance is the user's own message (F8, F10); the agent's words are no evidence of a goal.
	expect(rows(h, "SELECT DISTINCT message_id AS id FROM goals_source")).toEqual(
		[{ id: ex.inputMessageId }],
	);
	// The unit order: curate-memory, then the goals.
	expect(
		h
			.units()
			.map((u) => u.step)
			.filter((step) => step !== "prepare-recall"),
	).toEqual(["curate-memory", "curate-goals"]);
	expect(h.log().every((e) => e.curated)).toBe(true);
	// The decision stands on the goals and the events' messages.
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-goals")!;
	expect(
		rows(
			h,
			"SELECT ref_type AS t, COUNT(*) AS n FROM steward_decision_ref WHERE decision_id = ? GROUP BY ref_type",
			String(decision.id),
		),
	).toEqual([
		{ t: "goal", n: 2 },
		{ t: "message", n: 2 },
	]);
	// The model was shown the events and no goal yet.
	expect(h.inference.callsOf("curate-goals")[0]!.data).toMatchObject({
		goals: [],
	});
});

test("goals:false skips the goal step; a missing judgment counts as true; time alone never withdraws a goal", async () => {
	const h = await setup();
	h.inference.script("curate-memory", judged(false), empty);
	h.inference.script("curate-goals", {
		goals: [change({ text: "英語を話せるようになりたい" })],
	});
	await h.run({ user: "天気の話", answer: "晴れです", end: "completed" });
	await h.drain();
	expect(h.inference.callsOf("curate-goals")).toHaveLength(0);
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM steward_goal_todo").get(),
		),
	).toEqual({ n: 0 });
	await h.run({
		user: "英語を話せるようになりたい",
		answer: "いいですね",
		end: "completed",
	});
	await h.drain();
	expect(h.inference.callsOf("curate-goals")).toHaveLength(1);
	expect(goalsOf(h)).toMatchObject([{ status: "adopted" }]);
	// A year later nothing has touched it.
	h.time.ms += 400 * 24 * 3600 * 1000;
	await h.kick();
	await h.drain();
	expect(goalsOf(h)).toMatchObject([{ status: "adopted", revision: 1 }]);
	expect(h.inference.callsOf("curate-goals")).toHaveLength(1);
});

test("a goal request is answered by the goal step, not by curate-memory", async () => {
	const h = await setup();
	h.inference.script("curate-memory", judged(true), empty);
	h.inference.script(
		"curate-goals",
		{ goals: [change({ text: "音声応答の遅延を減らしたい" })] },
		(data) => {
			const goals = data.goals as Array<{ ref: string; text: string }>;
			expect(goals).toMatchObject([{ ref: "gl1", status: "adopted" }]);
			return { goals: [change({ op: "complete", ref: "gl1", request: "r1" })] };
		},
	);
	await h.run({
		user: "音声応答の遅延を減らしたい",
		answer: "了解",
		end: "completed",
	});
	await h.drain();
	await h.run({
		user: "音声の遅延の目標はもう終わった",
		answer: "お疲れさまでした",
		end: "completed",
		requests: [{ kind: "goal", what: "音声の遅延の目標は完了" }],
	});
	await h.drain();
	expect(goalsOf(h)).toMatchObject([{ status: "completed", revision: 2 }]);
	expect(h.inbox()).toMatchObject([{ kind: "goal", state: "done", what: "" }]);
	// curate-memory never saw the goal request.
	for (const call of h.inference.callsOf("curate-memory"))
		expect(call.data.requests).toEqual([]);
});

test("a goal request is ended at once when the application keeps no goals", async () => {
	const h = await setupSteward({});
	harnesses.push(h);
	h.inference.script("curate-memory", empty);
	await h.run({
		user: "目標は終わった",
		answer: "了解",
		end: "completed",
		requests: [{ kind: "goal", what: "目標は完了" }],
	});
	await h.drain();
	expect(h.inbox()).toMatchObject([
		{ kind: "goal", state: "none", resultCode: "goals_unavailable" },
	]);
});

test("a goal step that fails three times drops its events' reflection and the chain goes on", async () => {
	const h = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-goals", "bad", "bad", "bad");
	await h.run({
		user: "走りたい",
		answer: "いいですね",
		end: "completed",
	});
	await h.drain();
	expect(
		h
			.units()
			.filter((u) => u.step === "curate-goals")
			.map((u) => u.state),
	).toEqual(["failed", "failed", "failed"]);
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM steward_goal_todo").get(),
		),
	).toEqual({ n: 0 });
	expect(h.log().every((e) => e.curated)).toBe(true);
});

test("an op the host can not trust is dropped: unknown evidence, unknown ref, adopted goal withdrawn as a proposal", async () => {
	const h = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-goals", {
		goals: [
			change({ text: "目標A", evidence: "e9" }),
			change({ op: "revise", ref: "gl7", text: "目標B" }),
			change({ op: "adopt", text: null }),
			change({ text: "目標C" }),
		],
	});
	await h.run({ user: "目標C", answer: "了解", end: "completed" });
	await h.drain();
	expect(goalsOf(h)).toMatchObject([{ text: "目標C", status: "adopted" }]);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-goals")!;
	expect(decision.results).toMatchObject([
		{ index: 0, status: "rejected", code: "unknown_evidence" },
		{ index: 1, status: "rejected", code: "unknown_ref" },
		{ index: 2, status: "rejected", code: "invalid_input" },
		{ index: 3, status: "applied" },
	]);
});

async function proposals(h: StewardHarness, texts: string[]) {
	const out: string[] = [];
	for (const text of texts) {
		const id = await h.say("user", text);
		out.push(id);
		await h.goals!.propose(GOALS_ACCESS, {
			scopeKey: CONVERSATION_DEFAULT_SCOPE,
			desiredState: text,
			source: source(id),
			sourceMessageIds: [id],
		});
	}
	return out;
}

test("the goal upkeep withdraws duplicate proposals and never an adopted goal", async () => {
	const h = await setup();
	const mid = await h.say("user", "採用済み");
	await h.goals!.adopt(GOALS_ACCESS, {
		scopeKey: CONVERSATION_DEFAULT_SCOPE,
		desiredState: "毎朝走る",
		source: source(mid),
		sourceMessageIds: [mid],
	});
	await proposals(h, [
		"ランニングを習慣にする",
		"毎朝のランニング",
		"英語を勉強する",
	]);
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			{
				kind: "preference",
				key: "food.spicy",
				text: "辛い物が好き",
				evidence: "e1",
				quote: null,
				validFrom: null,
				validUntil: null,
				negated: false,
			},
		],
		route: [
			{ event: "e1", world: false, goals: false },
			{ event: "e2", world: false, goals: false },
		],
	});
	h.inference.script(
		"consolidate-goals",
		(data) => {
			expect(data).toMatchObject({
				limit: 50,
				count: 3,
				adopted: ["毎朝走る"],
			});
			const proposals = data.proposals as Array<{ ref: string; text: string }>;
			const refs = proposals.map((p) => p.ref);
			expect(refs).toEqual(["gl1", "gl2", "gl3"]);
			return {
				withdraw: [
					{ ref: "gl2", why: "duplicate" },
					{ ref: "gl9", why: "stale" },
				],
				changed: true,
			};
		},
		{ withdraw: [], changed: false },
	);
	h.inference.script("consolidate-memory", {
		merge: [],
		stop: [],
		tendencies: [],
		republishLongTerm: false,
		changed: false,
	});
	await h.run({ user: "辛い物が好き", answer: "覚えました", end: "completed" });
	await h.drain();
	const states = goalsOf(h).map((g) => `${g.text}:${g.status}`);
	expect(states).toEqual([
		"毎朝走る:adopted",
		"ランニングを習慣にする:proposed",
		"毎朝のランニング:withdrawn",
		"英語を勉強する:proposed",
	]);
	const decision = h.steward
		.decisions("c1")
		.filter((d) => d.step === "consolidate-goals")
		.at(-1)!;
	expect(decision.results).toMatchObject([
		{ ref: "gl9", status: "rejected", code: "unknown_ref" },
		{ ref: "gl2", status: "applied" },
	]);
});

test("near the proposal cap the model is told how full it is", async () => {
	const h = await setup();
	await proposals(
		h,
		Array.from({ length: 46 }, (_, i) => `提案${i}`),
	);
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			{
				kind: "preference",
				key: "food.salty",
				text: "塩辛い物が好き",
				evidence: "e1",
				quote: null,
				validFrom: null,
				validUntil: null,
				negated: false,
			},
		],
		route: [
			{ event: "e1", world: false, goals: false },
			{ event: "e2", world: false, goals: false },
		],
	});
	h.inference.script(
		"consolidate-goals",
		(data) => {
			expect(data).toMatchObject({ limit: 50, count: 46 });
			return {
				withdraw: [{ ref: "gl46", why: "low_relevance" }],
				changed: true,
			};
		},
		{ withdraw: [], changed: false },
	);
	h.inference.script("consolidate-memory", {
		merge: [],
		stop: [],
		tendencies: [],
		republishLongTerm: false,
		changed: false,
	});
	await h.run({
		user: "塩辛い物が好き",
		answer: "覚えました",
		end: "completed",
	});
	await h.drain();
	expect(goalsOf(h).filter((g) => g.status === "withdrawn")).toHaveLength(1);
});
