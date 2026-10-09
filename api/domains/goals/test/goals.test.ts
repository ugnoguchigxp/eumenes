import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	createGoalsService,
	goalEpochOf,
	goalRevisionOf,
	goalSnapshot,
	migration,
	operationMigration,
} from "..";
import type { GoalAccess } from "..";
import { goalHistory } from "../repository";
import { goalRevisionOfUnscoped } from "../service";
import { Database } from "bun:sqlite";

const alice: GoalAccess = { principal: "alice", scopeKeys: ["work"] };
const aliceBoth: GoalAccess = {
	principal: "alice",
	scopeKeys: ["work", "home"],
};
const bob: GoalAccess = { principal: "bob", scopeKeys: ["work"] };
const src = (id: string) => ({
	namespace: "conversation",
	kind: "message",
	id,
});

let dir: string;
let store: SqliteStore;
let counter = 0;
function service() {
	return createGoalsService(
		store,
		() => "2026-01-01T00:00:00.000Z",
		() => `g${++counter}`,
	);
}
const snap = (access: GoalAccess) =>
	store.readSnapshot((db) => goalSnapshot(db, access));

beforeEach(() => {
	counter = 0;
	dir = mkdtempSync(join(tmpdir(), "eumenes-goals-"));
	store = openStore(join(dir, "db.sqlite3"), [migration, operationMigration]);
});
afterEach(async () => {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("no goal gives an explicit absent snapshot and invents nothing", () => {
	const s = snap(alice);
	expect(s).toMatchObject({ state: "absent", goals: [], revision: 0 });
	expect(s.scopeEpochs).toEqual([{ scopeKey: "work", epoch: 0 }]);
	expect(s.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("explicit adopt, update and withdraw keep revisions and history", async () => {
	const goals = service();
	const goal = await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "  週内にRust移行を終える ",
		priority: 70,
		source: src("m1"),
	});
	expect(goal).toMatchObject({
		status: "adopted",
		revision: 1,
		desiredState: "週内にRust移行を終える",
		priority: 70,
	});
	expect(snap(alice)).toMatchObject({
		state: "present",
		goals: [{ goalId: goal.id, revision: 1, priority: 70 }],
	});
	const updated = await goals.update(alice, goal.id, {
		expectedRevision: 1,
		priority: 90,
		source: src("m2"),
	});
	expect(updated).toMatchObject({ revision: 2, priority: 90 });
	expect(updated.desiredState).toBe(goal.desiredState);
	const withdrawn = await goals.withdraw(alice, goal.id, {
		expectedRevision: 2,
		source: src("m3"),
	});
	expect(withdrawn).toMatchObject({ status: "withdrawn", revision: 3 });
	expect(snap(alice).state).toBe("absent");
	expect(
		store
			.read((db) => goalHistory(db, goal.id))
			.map((h) => [h.revision, h.status]),
	).toEqual([
		[1, "adopted"],
		[2, "adopted"],
		[3, "withdrawn"],
	]);
	await expect(
		goals.update(alice, goal.id, {
			expectedRevision: 3,
			priority: 1,
			source: src("m4"),
		}),
	).rejects.toThrow("goal_state_conflict");
});

test("stale revisions are rejected for update, withdraw and complete", async () => {
	const goals = service();
	const goal = await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "A",
		source: src("m1"),
	});
	expect(goal.priority).toBe(50);
	await goals.update(alice, goal.id, {
		expectedRevision: 1,
		desiredState: "B",
		source: src("m2"),
	});
	for (const op of [
		() =>
			goals.update(alice, goal.id, {
				expectedRevision: 1,
				desiredState: "C",
				source: src("m3"),
			}),
		() =>
			goals.withdraw(alice, goal.id, {
				expectedRevision: 1,
				source: src("m3"),
			}),
		() =>
			goals.complete(alice, goal.id, {
				expectedRevision: 1,
				source: src("m3"),
			}),
	])
		await expect(op()).rejects.toThrow("revision_conflict");
	expect(snap(alice).goals[0]).toMatchObject({
		desiredState: "B",
		revision: 2,
	});
	// revision is required: an update without it is invalid, not "latest wins".
	await expect(
		goals.update(alice, goal.id, {
			desiredState: "D",
			source: src("m4"),
		} as never),
	).rejects.toThrow("invalid_goal_input");
});

test("completed goals leave the adopted snapshot", async () => {
	const goals = service();
	const goal = await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "A",
		source: src("m1"),
	});
	const done = await goals.complete(alice, goal.id, {
		expectedRevision: 1,
		source: src("m2"),
	});
	expect(done.status).toBe("completed");
	expect(snap(alice).state).toBe("absent");
});

test("other principals and scopes see nothing and cannot touch goals", async () => {
	const goals = service();
	const goal = await goals.adopt(aliceBoth, {
		scopeKey: "home",
		desiredState: "private",
		source: src("m1"),
	});
	expect(snap(bob).state).toBe("absent");
	expect(snap({ principal: "alice", scopeKeys: ["work"] }).state).toBe(
		"absent",
	);
	expect(snap({ principal: "alice", scopeKeys: ["home"] }).goals).toHaveLength(
		1,
	);
	// Adopting into a scope the access does not cover is refused.
	await expect(
		goals.adopt(alice, {
			scopeKey: "home",
			desiredState: "x",
			source: src("m2"),
		}),
	).rejects.toThrow("goal_scope_forbidden");
	// Foreign goals look missing; the revision does not leak either.
	for (const who of [bob, alice])
		await expect(
			goals.update(who, goal.id, {
				expectedRevision: 1,
				priority: 1,
				source: src("m3"),
			}),
		).rejects.toThrow("invalid_goal");
	await expect(
		goals.withdraw(bob, goal.id, { expectedRevision: 1, source: src("m3") }),
	).rejects.toThrow("invalid_goal");
	store.read((db) => {
		expect(goalRevisionOf(db, goal.id, bob)).toBeNull();
		expect(goalRevisionOf(db, goal.id, alice)).toBeNull();
		expect(goalRevisionOf(db, goal.id, aliceBoth)?.revision).toBe(1);
	});
	expect(
		goalEpochOf(
			store.read((db) => db),
			"alice",
			"home",
		),
	).toBe(1);
	expect(snap(aliceBoth).goals[0]?.revision).toBe(1);
});

test("proposals never appear as adopted and need an explicit call", async () => {
	const goals = service();
	const proposal = await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "モデルが推定した目標",
		source: { namespace: "inference", kind: "run", id: "r1" },
	});
	expect(proposal).toMatchObject({ status: "proposed", revision: 1 });
	const before = snap(alice);
	expect(before).toMatchObject({ state: "absent", revision: 0 });
	expect(goals.proposals(alice).map((g) => g.id)).toEqual([proposal.id]);
	expect(goals.proposals(bob)).toEqual([]);
	// Nothing happens by itself: reading again, and time passing, adopt nothing.
	expect(snap(alice).digest).toBe(before.digest);
	// A proposal cannot be updated or completed as if adopted.
	await expect(
		goals.update(alice, proposal.id, {
			expectedRevision: 1,
			priority: 99,
			source: src("m1"),
		}),
	).rejects.toThrow("goal_state_conflict");
	await expect(
		goals.complete(alice, proposal.id, {
			expectedRevision: 1,
			source: src("m1"),
		}),
	).rejects.toThrow("goal_state_conflict");
	expect(snap(alice).state).toBe("absent");
	// Explicit adoption with a stale revision fails; with the right one it works.
	await expect(
		goals.adoptProposal(alice, proposal.id, {
			expectedRevision: 2,
			source: src("m2"),
		}),
	).rejects.toThrow("revision_conflict");
	await expect(
		goals.adoptProposal(bob, proposal.id, {
			expectedRevision: 1,
			source: src("m2"),
		}),
	).rejects.toThrow("invalid_goal");
	const adopted = await goals.adoptProposal(alice, proposal.id, {
		expectedRevision: 1,
		source: src("m2"),
	});
	expect(adopted).toMatchObject({
		status: "adopted",
		revision: 2,
		proposedFrom: { id: "r1" },
		source: { id: "m2" },
	});
	expect(snap(alice)).toMatchObject({ state: "present", revision: 1 });
});

test("rejecting a proposal does not move the goal epoch", async () => {
	const goals = service();
	const proposal = await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "x",
		source: src("m1"),
	});
	await goals.withdraw(alice, proposal.id, {
		expectedRevision: 1,
		source: src("m2"),
	});
	expect(snap(alice)).toMatchObject({ state: "absent", revision: 0 });
	expect(goals.proposals(alice)).toEqual([]);
});

test("epoch and revision change on every visible change, enabling receipt invalidation", async () => {
	const goals = service();
	const a = await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "A",
		source: src("m1"),
	});
	const s1 = snap(alice);
	const rev1 = store.read((db) => goalRevisionOfUnscoped(db, a.id));
	expect(rev1).toMatchObject({ revision: 1, status: "adopted", scopeEpoch: 1 });
	await goals.update(alice, a.id, {
		expectedRevision: 1,
		desiredState: "A2",
		source: src("m2"),
	});
	const s2 = snap(alice);
	expect(s2.revision).toBe(s1.revision + 1);
	expect(s2.digest).not.toBe(s1.digest);
	// A receipt that recorded revision 1 / epoch 1 is now detectably stale.
	const rev2 = store.read((db) => goalRevisionOfUnscoped(db, a.id));
	expect(rev2?.revision).toBeGreaterThan(rev1?.revision ?? 0);
	expect(rev2?.scopeEpoch).toBeGreaterThan(rev1?.scopeEpoch ?? 0);
	await goals.withdraw(alice, a.id, { expectedRevision: 2, source: src("m3") });
	const s3 = snap(alice);
	expect(s3.state).toBe("absent");
	expect(s3.revision).toBe(s2.revision + 1);
	expect(store.read((db) => goalRevisionOfUnscoped(db, a.id))).toMatchObject({
		status: "withdrawn",
		revision: 3,
		scopeEpoch: 3,
	});
	// Adopting again after "absent" also changes the epoch (absent receipts expire).
	await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "B",
		source: src("m4"),
	});
	expect(snap(alice).revision).toBe(s3.revision + 1);
	// An unrelated scope's epoch is untouched.
	expect(snap({ principal: "alice", scopeKeys: ["home"] }).revision).toBe(0);
	expect(store.read((db) => goalRevisionOf(db, "missing", alice))).toBeNull();
});

test("snapshot orders by priority and is one consistent read", async () => {
	const goals = service();
	await goals.adopt(aliceBoth, {
		scopeKey: "work",
		desiredState: "low",
		priority: 10,
		source: src("m1"),
	});
	await goals.adopt(aliceBoth, {
		scopeKey: "home",
		desiredState: "high",
		priority: 80,
		source: src("m2"),
	});
	const s = snap({ principal: "alice", scopeKeys: ["home", "work", "work"] });
	expect(s.scopeKeys).toEqual(["home", "work"]);
	expect(s.goals.map((g) => g.desiredState)).toEqual(["high", "low"]);
	// A writer on another connection commits between two reads inside the
	// snapshot: both reads still see the state the snapshot started with.
	const writer = new Database(join(dir, "db.sqlite3"));
	writer.exec("PRAGMA busy_timeout = 5000");
	try {
		const seen = store.readSnapshot((db) => {
			const first = goalSnapshot(db, aliceBoth);
			writer.transaction(() =>
				goals.adoptInTransaction(writer, aliceBoth, {
					scopeKey: "work",
					desiredState: "committed mid-snapshot",
					source: src("m3"),
				}),
			)();
			const second = goalSnapshot(db, aliceBoth);
			return { first, second };
		});
		expect(seen.second).toEqual(seen.first);
		expect(seen.first.goals).toHaveLength(2);
		expect(seen.first.revision).toBe(
			seen.first.scopeEpochs.reduce((n, e) => n + e.epoch, 0),
		);
		// The commit was real: a new snapshot sees it, with a higher revision.
		const after = snap(aliceBoth);
		expect(after.goals).toHaveLength(3);
		expect(after.revision).toBe(seen.first.revision + 1);
		expect(after.digest).not.toBe(seen.first.digest);
	} finally {
		writer.close();
	}
});

test("an access-less revision lookup is not part of the World-facing exports", () => {
	// goalRevisionOf requires access (a missing argument is a type error), and a
	// goal of another principal is reported exactly like a missing one.
	expect(goalRevisionOf.length).toBe(3);
	// @ts-expect-error access is required on the exported function
	const unscoped = () => store.read((db) => goalRevisionOf(db, "g1"));
	expect(typeof unscoped).toBe("function");
});

test("re-proposing the same thing from the same source is deduplicated", async () => {
	const goals = service();
	const first = await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "Ship the  report",
		source: src("m1"),
	});
	for (let i = 0; i < 100; i++)
		expect(
			await goals.propose(alice, {
				scopeKey: "work",
				desiredState: " ship the report ",
				source: src("m1"),
			}),
		).toEqual(first);
	expect(await goals.proposals(alice)).toHaveLength(1);
	// A different source, scope, principal or text is a different proposal.
	await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "ship the report",
		source: src("m2"),
	});
	await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "something else",
		source: src("m1"),
	});
	await goals.propose(aliceBoth, {
		scopeKey: "home",
		desiredState: "ship the report",
		source: src("m1"),
	});
	expect(await goals.proposals(aliceBoth)).toHaveLength(4);
	// Once rejected, the same proposal may be made again.
	await goals.withdraw(alice, first.id, {
		expectedRevision: 1,
		source: src("m9"),
	});
	const again = await goals.propose(alice, {
		scopeKey: "work",
		desiredState: "ship the report",
		source: src("m1"),
	});
	expect(again.id).not.toBe(first.id);
});

test("operationKey makes adopt and propose idempotent per principal and scope", async () => {
	const goals = service();
	const input = {
		scopeKey: "work",
		desiredState: "once",
		priority: 70,
		source: src("m1"),
		operationKey: "op-1",
	};
	const first = await goals.adopt(alice, input);
	const replay = await goals.adopt(alice, input);
	expect(replay).toEqual(first);
	expect(snap(alice).goals).toHaveLength(1);
	expect(snap(alice).revision).toBe(1);
	// Different payload or kind under the same key conflicts and writes nothing.
	await expect(
		goals.adopt(alice, { ...input, desiredState: "other" }),
	).rejects.toThrow("operation_conflict");
	await expect(goals.propose(alice, input)).rejects.toThrow(
		"operation_conflict",
	);
	expect(snap(alice).goals).toHaveLength(1);
	// The same key in another principal or scope is independent.
	const bobs = await goals.adopt(bob, input);
	expect(bobs.id).not.toBe(first.id);
	const home = await goals.adopt(aliceBoth, { ...input, scopeKey: "home" });
	expect(home.id).not.toBe(first.id);
	// A replay returns the stored goal even after it moved on.
	await goals.update(alice, first.id, {
		expectedRevision: 1,
		priority: 5,
		source: src("m2"),
	});
	expect(await goals.adopt(alice, input)).toMatchObject({
		id: first.id,
		revision: 2,
	});
	// Proposals too.
	const p = await goals.propose(alice, { ...input, operationKey: "op-p" });
	expect(
		(await goals.propose(alice, { ...input, operationKey: "op-p" })).id,
	).toBe(p.id);
	await expect(
		goals.adopt(alice, { ...input, operationKey: "" }),
	).rejects.toThrow("invalid_goal_input");
});

test("transaction rollback leaves the ledger, history and epoch unchanged", async () => {
	const goals = service();
	const a = await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "A",
		source: src("m1"),
	});
	const before = snap(alice);
	await expect(
		store.write((db) => {
			goals.updateInTransaction(db, alice, a.id, {
				expectedRevision: 1,
				desiredState: "changed",
				source: src("m2"),
			});
			goals.adoptInTransaction(db, alice, {
				scopeKey: "work",
				desiredState: "extra",
				source: src("m2"),
			});
			goals.withdrawInTransaction(db, alice, a.id, {
				expectedRevision: 2,
				source: src("m2"),
			});
			// Reads inside the transaction see the writer's own changes.
			expect(goalSnapshot(db, alice).state).toBe("present");
			throw new Error("host_abort");
		}),
	).rejects.toThrow("host_abort");
	expect(snap(alice)).toEqual(before);
	expect(store.read((db) => goalHistory(db, a.id))).toHaveLength(1);
});

test("inputs are bounded and rejected rather than truncated", async () => {
	const goals = service();
	const base = { scopeKey: "work", source: src("m1") };
	for (const bad of [
		{ ...base, desiredState: "" },
		{ ...base, desiredState: "   " },
		{ ...base, desiredState: "x".repeat(501) },
		{ ...base, desiredState: "ok", priority: 101 },
		{ ...base, desiredState: "ok", priority: 1.5 },
		{ ...base, desiredState: "ok", source: { namespace: "a" } },
		{ ...base, desiredState: "ok", extra: true },
	])
		await expect(goals.adopt(alice, bad as never)).rejects.toThrow(
			"invalid_goal_input",
		);
	await expect(
		goals.adopt(
			{ principal: "alice", scopeKeys: [] },
			{
				...base,
				desiredState: "ok",
			},
		),
	).rejects.toThrow("invalid_goal_access");
	expect(snap(alice).state).toBe("absent");
	for (let i = 0; i < 30; i++)
		await goals.adopt(alice, { ...base, desiredState: `g${i}` });
	await expect(
		goals.adopt(alice, { ...base, desiredState: "one too many" }),
	).rejects.toThrow("goal_limit");
	expect(snap(alice).goals).toHaveLength(30);
});

test("goals survive restart", async () => {
	const goals = service();
	await goals.adopt(alice, {
		scopeKey: "work",
		desiredState: "persist",
		source: src("m1"),
	});
	await store.close();
	store = openStore(join(dir, "db.sqlite3"), [migration, operationMigration]);
	expect(snap(alice)).toMatchObject({
		state: "present",
		revision: 1,
		goals: [{ desiredState: "persist" }],
	});
});
