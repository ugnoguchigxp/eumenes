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
const empty = { resolve: [] };
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

/** A goal the earlier reflection kept, standing on the user's message. */
async function adoptGoal(h: StewardHarness, text: string) {
	const id = await h.say("user", text);
	await h.goals!.adopt(GOALS_ACCESS, {
		scopeKey: CONVERSATION_DEFAULT_SCOPE,
		desiredState: text,
		source: source(id),
		sourceMessageIds: [id],
	});
	return id;
}

test("a goal request is answered by the goal step, not by curate-memory; an exchange alone makes no goal step", async () => {
	const h = await setup();
	await adoptGoal(h, "音声応答の遅延を減らしたい");
	// An exchange alone never asks a model: nothing reflects every turn.
	await h.run({ user: "天気の話", answer: "晴れです", end: "completed" });
	await h.drain();
	expect(h.units()).toEqual([]);
	h.inference.script("curate-goals", (data) => {
		const goals = data.goals as Array<{ ref: string; text: string }>;
		expect(goals).toMatchObject([{ ref: "gl1", status: "adopted" }]);
		return { goals: [change({ op: "complete", ref: "gl1", request: "r1" })] };
	});
	await h.run({
		user: "音声の遅延の目標はもう終わった",
		answer: "お疲れさまでした",
		end: "completed",
		requests: [{ kind: "goal", what: "音声の遅延の目標は完了" }],
	});
	await h.drain();
	expect(goalsOf(h)).toMatchObject([{ status: "completed", revision: 2 }]);
	expect(h.inbox()).toMatchObject([{ kind: "goal", state: "done", what: "" }]);
	expect(h.units().map((u) => u.step)).toEqual(["curate-goals"]);
	// curate-memory never saw the goal request.
	expect(h.inference.callsOf("curate-memory")).toHaveLength(0);
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

test("a goal step that fails three times gives the request up and the pipeline goes on", async () => {
	const h = await setup();
	h.inference.script("curate-goals", "bad", "bad", "bad");
	await h.run({
		user: "走りたい",
		answer: "いいですね",
		end: "completed",
		requests: [{ kind: "goal", what: "走ることを目標にする" }],
	});
	await h.drain();
	expect(
		h
			.units()
			.filter((u) => u.step === "curate-goals")
			.map((u) => u.state),
	).toEqual(["failed", "failed", "failed"]);
	expect(h.inbox()).toMatchObject([
		{ kind: "goal", state: "none", resultCode: "steward_failed" },
	]);
});

test("an op the host can not trust is dropped: unknown evidence, unknown ref, a goal without wording", async () => {
	const h = await setup();
	h.inference.script("curate-goals", {
		goals: [
			change({ text: "目標A", evidence: "e9" }),
			change({ op: "revise", ref: "gl7", text: "目標B" }),
			change({ op: "adopt", text: null }),
			change({ text: "目標C", evidence: "e1", request: "r1" }),
		],
	});
	await h.run({
		user: "目標C",
		answer: "了解",
		end: "completed",
		requests: [{ kind: "goal", what: "目標C" }],
	});
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
