import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createGoalsService, goalEpochOf, migrations } from "..";
import type { GoalAccess, GoalOp } from "..";

const alice: GoalAccess = { principal: "alice", scopeKeys: ["work"] };
const bob: GoalAccess = { principal: "bob", scopeKeys: ["work"] };
const src = (id: string) => ({
	namespace: "conversation",
	kind: "message",
	id,
});

let dir: string;
let store: SqliteStore;
let counter = 0;
let tick = 0;
function service() {
	return createGoalsService(
		store,
		() => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString(),
		() => `g${++counter}`,
	);
}
const apply = (goals: ReturnType<typeof service>, ops: GoalOp[], a = alice) =>
	store.write((db) => goals.applyInTransaction(db, a, ops));
const rows = (sql: string, ...args: string[]) =>
	store.read((db) => db.query(sql).all(...args)) as Record<string, unknown>[];
const epoch = () => store.read((db) => goalEpochOf(db, "alice", "work"));

beforeEach(() => {
	counter = 0;
	tick = 0;
	dir = mkdtempSync(join(tmpdir(), "eumenes-goals-steward-"));
	store = openStore(join(dir, "db.sqlite3"), migrations);
});
afterEach(async () => {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
});

const msgs = (...ids: string[]) => ids;

test("a batch reports each operation as applied or rejected and keeps the rest", async () => {
	const goals = service();
	const results = await apply(goals, [
		{
			op: "propose",
			scopeKey: "work",
			desiredState: "推測した目標",
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
			entityIds: ["e1"],
		},
		{
			op: "adopt",
			scopeKey: "work",
			desiredState: "明言した目標",
			priority: 80,
			source: src("m1"),
			sourceMessageIds: msgs("m1", "m2"),
		},
		{
			op: "complete",
			goalId: "missing",
			expectedRevision: 1,
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
		},
		{
			op: "adopt",
			scopeKey: "elsewhere",
			desiredState: "範囲外",
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
		},
		{
			op: "adopt",
			scopeKey: "work",
			desiredState: "",
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
		},
		{
			op: "adopt",
			scopeKey: "work",
			desiredState: "根拠なし",
			source: src("m1"),
			sourceMessageIds: [],
		},
	]);
	expect(results.map((r) => r.status)).toEqual([
		"applied",
		"applied",
		"rejected",
		"rejected",
		"rejected",
		"rejected",
	]);
	expect(
		results.map((r) => (r.status === "rejected" ? r.reason : null)),
	).toEqual([
		null,
		null,
		"invalid_goal",
		"goal_scope_forbidden",
		"invalid_goal_input",
		"source_required",
	]);
	expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
	const listed = store.read((db) =>
		goals.listForStewardInTransaction(db, alice),
	);
	expect(listed.map((g) => [g.status, g.desiredState])).toEqual([
		["adopted", "明言した目標"],
		["proposed", "推測した目標"],
	]);
	// Rejected operations wrote nothing, not even provenance.
	expect(rows("SELECT * FROM goals_ledger")).toHaveLength(2);
	expect(rows("SELECT * FROM goals_history")).toHaveLength(2);
});

test("adopt from a proposal, revise, complete and withdraw record per-revision sources", async () => {
	const goals = service();
	const [proposed] = await apply(goals, [
		{
			op: "propose",
			scopeKey: "work",
			desiredState: "ランニングを続ける",
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
			entityIds: ["e1"],
		},
	]);
	const id = proposed?.status === "applied" ? proposed.goal.id : "";
	const before = epoch();
	const second = await apply(goals, [
		{
			op: "adopt",
			goalId: id,
			expectedRevision: 1,
			desiredState: "毎朝ランニングを続ける",
			priority: 90,
			source: src("m2"),
			sourceMessageIds: msgs("m2"),
			entityIds: ["e2"],
		},
		{
			op: "revise",
			goalId: id,
			expectedRevision: 2,
			priority: 70,
			source: src("m3"),
			sourceMessageIds: msgs("m3", "m4"),
		},
		{
			op: "revise",
			goalId: id,
			expectedRevision: 2,
			priority: 10,
			source: src("m5"),
			sourceMessageIds: msgs("m5"),
		},
		{
			op: "complete",
			goalId: id,
			expectedRevision: 3,
			source: src("m6"),
			sourceMessageIds: msgs("m6"),
		},
		{
			op: "withdraw",
			goalId: id,
			expectedRevision: 4,
			source: src("m7"),
			sourceMessageIds: msgs("m7"),
		},
	]);
	expect(
		second.map((r) => (r.status === "rejected" ? r.reason : "ok")),
	).toEqual(["ok", "ok", "revision_conflict", "ok", "goal_state_conflict"]);
	expect(epoch()).toBeGreaterThan(before);
	const goal = second[0]?.status === "applied" ? second[0].goal : null;
	expect(goal).toMatchObject({
		status: "adopted",
		desiredState: "毎朝ランニングを続ける",
		priority: 90,
		revision: 2,
	});
	expect(
		rows(
			"SELECT revision, message_id FROM goals_source WHERE goal_id=? ORDER BY revision, message_id",
			id,
		).map((r) => `${r.revision}:${r.message_id}`),
	).toEqual(["1:m1", "2:m2", "3:m3", "3:m4", "4:m6"]);
	// Entity links accumulate over revisions.
	expect(
		rows(
			"SELECT entity_id FROM goals_entity WHERE goal_id=? ORDER BY 1",
			id,
		).map((r) => r.entity_id),
	).toEqual(["e1", "e2"]);
});

test("limits, operation keys and the access check hold for batch operations", async () => {
	const goals = service();
	const adopt = (i: number, key?: string): GoalOp => ({
		op: "adopt",
		scopeKey: "work",
		desiredState: `g${i}`,
		source: src("m1"),
		sourceMessageIds: msgs("m1"),
		operationKey: key,
	});
	const filled = await apply(
		goals,
		Array.from({ length: 31 }, (_, i) => adopt(i)),
	);
	expect(filled.filter((r) => r.status === "applied")).toHaveLength(30);
	expect(filled[30]).toMatchObject({
		status: "rejected",
		reason: "goal_limit",
	});
	const propose = (i: number): GoalOp => ({
		op: "propose",
		scopeKey: "work",
		desiredState: `p${i}`,
		source: src("m1"),
		sourceMessageIds: msgs("m1"),
	});
	const proposals = await apply(
		goals,
		Array.from({ length: 50 }, (_, i) => propose(i)),
	);
	expect(proposals.filter((r) => r.status === "applied")).toHaveLength(50);
	expect(await apply(goals, [propose(50)])).toMatchObject([
		{ status: "rejected", reason: "goal_limit" },
	]);
	await expect(
		apply(
			goals,
			Array.from({ length: 51 }, (_, i) => adopt(i)),
		),
	).rejects.toThrow("goal_ops_limit");

	const other = service();
	const keyed = (text: string): GoalOp => ({
		op: "propose",
		scopeKey: "work",
		desiredState: text,
		source: src("m1"),
		sourceMessageIds: msgs("m1"),
		operationKey: "unit-1:0",
	});
	const bobFirst = await apply(other, [keyed("same")], bob);
	const again = await apply(other, [keyed("same"), keyed("changed")], bob);
	expect(bobFirst[0]).toMatchObject({ status: "applied", replayed: false });
	expect(again[0]).toMatchObject({ status: "applied", replayed: true });
	expect(again[0]?.status === "applied" && again[0].goal.id).toBe(
		bobFirst[0]?.status === "applied" && bobFirst[0].goal.id,
	);
	expect(again[1]).toMatchObject({ reason: "operation_conflict" });
	// A different source message set is a different operation.
	const moved = await apply(
		other,
		[{ ...keyed("same"), sourceMessageIds: msgs("m9") }],
		bob,
	);
	expect(moved[0]).toMatchObject({ reason: "operation_conflict" });
	// Alice cannot touch bob's goal.
	const id = bobFirst[0]?.status === "applied" ? bobFirst[0].goal.id : "";
	const foreign = await apply(goals, [
		{
			op: "withdraw",
			goalId: id,
			expectedRevision: 1,
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
		},
	]);
	expect(foreign[0]).toMatchObject({ reason: "invalid_goal" });
});

test("a failure that is not a refusal aborts the whole transaction", async () => {
	const goals = service();
	await expect(
		store.write((db) => {
			goals.applyInTransaction(db, alice, [
				{
					op: "adopt",
					scopeKey: "work",
					desiredState: "kept?",
					source: src("m1"),
					sourceMessageIds: msgs("m1"),
				},
			]);
			goals.applyInTransaction(db, { principal: "alice", scopeKeys: [] }, [
				{
					op: "adopt",
					scopeKey: "work",
					desiredState: "x",
					source: src("m1"),
					sourceMessageIds: msgs("m1"),
				},
			]);
		}),
	).rejects.toThrow("invalid_goal_access");
	expect(rows("SELECT * FROM goals_ledger")).toHaveLength(0);
	expect(rows("SELECT * FROM goals_source")).toHaveLength(0);
});

test("the context listing orders adopted goals by priority then recency", async () => {
	const goals = service();
	const ids: string[] = [];
	for (const [text, priority] of [
		["low", 10],
		["high-old", 90],
		["high-new", 90],
		["mid", 50],
	] as const) {
		const [r] = await apply(goals, [
			{
				op: "adopt",
				scopeKey: "work",
				desiredState: text,
				priority,
				source: src("m1"),
				sourceMessageIds: msgs("m1"),
			},
		]);
		if (r?.status === "applied") ids.push(r.goal.id);
	}
	await apply(goals, [
		{
			op: "propose",
			scopeKey: "work",
			desiredState: "not adopted",
			source: src("m1"),
			sourceMessageIds: msgs("m1"),
		},
	]);
	const order = () =>
		store
			.read((db) => goals.adoptedForContextInTransaction(db, alice))
			.map((g) => g.desiredState);
	expect(order()).toEqual(["high-new", "high-old", "mid", "low"]);
	// Revising the older high goal makes it the most recently revised.
	await apply(goals, [
		{
			op: "revise",
			goalId: ids[1] ?? "",
			expectedRevision: 1,
			desiredState: "high-old v2",
			source: src("m2"),
			sourceMessageIds: msgs("m2"),
		},
	]);
	expect(order()).toEqual(["high-old v2", "high-new", "mid", "low"]);
	expect(
		store.read((db) => goals.adoptedForContextInTransaction(db, bob)),
	).toEqual([]);
});

const textTables = [
	"goals_ledger",
	"goals_history",
	"goals_source",
	"goals_entity",
	"goals_scope_epochs",
];
const dump = () =>
	JSON.stringify(
		store.read((db) =>
			textTables.map((t) => db.query(`SELECT * FROM ${t}`).all()),
		),
	);

async function seedForget(goals: ReturnType<typeof service>) {
	const make = async (
		text: string,
		messages: string[],
		entities: string[],
	): Promise<string> => {
		const [r] = await apply(goals, [
			{
				op: "adopt",
				scopeKey: "work",
				desiredState: text,
				source: src(messages[0] ?? "m"),
				sourceMessageIds: messages,
				entityIds: entities,
			},
		]);
		return r?.status === "applied" ? r.goal.id : "";
	};
	const named = await make("秘密の引っ越し計画", ["m1"], []);
	await apply(goals, [
		{
			op: "revise",
			goalId: named,
			expectedRevision: 1,
			desiredState: "秘密の引っ越し計画その2",
			source: src("m2"),
			sourceMessageIds: msgs("m2", "m3"),
		},
	]);
	const linked = await make("交際相手との旅行", ["m4"], ["entity-x"]);
	await apply(goals, [
		{
			op: "complete",
			goalId: linked,
			expectedRevision: 1,
			source: src("m5"),
			sourceMessageIds: msgs("m5"),
		},
	]);
	const keep = await make("英語の勉強", ["m1", "m9"], ["entity-y"]);
	return { named, linked, keep };
}

test("forgetting deletes named and entity-linked goals with all history and provenance", async () => {
	const goals = service();
	const { named, linked, keep } = await seedForget(goals);
	const epochBefore = epoch();
	expect(dump()).toContain("秘密の引っ越し計画その2");

	const preview = store.read((db) =>
		goals.resolveForgetInTransaction(db, {
			goalIds: [named],
			entityIds: ["entity-x"],
		}),
	);
	expect(preview).toEqual({
		goalIds: [named, linked].sort(),
		messageIds: ["m1", "m2", "m3", "m4", "m5"],
	});
	// The preview is read-only.
	expect(epoch()).toBe(epochBefore);
	expect(rows("SELECT * FROM goals_ledger")).toHaveLength(3);

	const result = await store.write((db) =>
		goals.forgetGoalsInTransaction(db, {
			goalIds: [named],
			entityIds: ["entity-x"],
		}),
	);
	expect(result).toEqual(preview);
	const left = dump();
	for (const text of [
		"秘密の引っ越し計画",
		"交際相手との旅行",
		"entity-x",
		named,
		linked,
		"m3",
		"m4",
		"m5",
	])
		expect(left).not.toContain(text);
	// The goal that merely shared a source message survives, with its own rows.
	expect(rows("SELECT id FROM goals_ledger").map((r) => r.id)).toEqual([keep]);
	expect(
		rows("SELECT message_id FROM goals_source")
			.map((r) => r.message_id)
			.sort(),
	).toEqual(["m1", "m9"]);
	expect(rows("SELECT entity_id FROM goals_entity")).toEqual([
		{ entity_id: "entity-y" },
	]);
	expect(epoch()).toBeGreaterThan(epochBefore);
	expect(
		store.read((db) => goals.adoptedForContextInTransaction(db, alice)),
	).toMatchObject([{ goalId: keep }]);
});

test("forgetting is idempotent and unknown ids are ignored", async () => {
	const goals = service();
	const { named } = await seedForget(goals);
	const forget = () =>
		store.write((db) =>
			goals.forgetGoalsInTransaction(db, {
				goalIds: [named, "nope"],
				entityIds: ["nope"],
			}),
		);
	const first = await forget();
	expect(first.goalIds).toEqual([named]);
	expect(first.messageIds).toEqual(["m1", "m2", "m3"]);
	const epochAfter = epoch();
	expect(await forget()).toEqual({ goalIds: [], messageIds: [] });
	expect(epoch()).toBe(epochAfter);
	expect(
		await store.write((db) =>
			goals.forgetGoalsInTransaction(db, { goalIds: [], entityIds: [] }),
		),
	).toEqual({ goalIds: [], messageIds: [] });
	await expect(
		store.write((db) =>
			goals.forgetGoalsInTransaction(db, { goalIds: [""], entityIds: [] }),
		),
	).rejects.toThrow("invalid_goal_forget_input");
});

test("forgetting rolls back with the surrounding transaction", async () => {
	const goals = service();
	const { named } = await seedForget(goals);
	const before = dump();
	await expect(
		store.write((db) => {
			goals.forgetGoalsInTransaction(db, { goalIds: [named], entityIds: [] });
			throw new Error("host_abort");
		}),
	).rejects.toThrow("host_abort");
	expect(dump()).toBe(before);
});
