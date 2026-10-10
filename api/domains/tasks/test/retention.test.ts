import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	createTasks,
	migrations,
	type TaskFence,
	type TaskKindDefinition,
} from "..";
import { createTaskSchema } from "../contracts";
import { capacity, migration as initSql, putQuestion } from "../repository";

const stores: SqliteStore[] = [],
	dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-09T00:00:00Z");
function setup(
	extra: Partial<Parameters<typeof createTasks>[1]> = {},
	purge?: TaskKindDefinition["purgeInTransaction"],
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-tasks-retention-"));
	dirs.push(dir);
	const file = join(dir, "db");
	const store = openStore(file, migrations);
	stores.push(store);
	const clock = { t: T0 };
	const kind: TaskKindDefinition = {
		kind: "coding",
		version: 1,
		available: () => true,
		startInTransaction() {},
		stopInTransaction() {},
		...(purge ? { purgeInTransaction: purge } : {}),
	};
	const tasks = createTasks(store, {
		now: () => clock.t,
		kinds: [kind],
		...extra,
	});
	return { store, file, dir, tasks, clock };
}
type Harness = ReturnType<typeof setup>;
const input = () =>
	createTaskSchema.parse({
		requestId: crypto.randomUUID(),
		kind: "coding",
		version: 1,
		title: "fixture task",
		request: "implement the requested change",
		completionConditions: ["checks pass"],
		startMode: "start",
		grant: {
			workspaceId: "fixture-workspace",
			operations: ["read", "edit", "check", "review"],
			expiresAt: new Date(T0 + 365 * DAY).toISOString(),
		},
	});
function fence(h: Harness, taskId: string): TaskFence {
	const t = h.tasks.get(taskId).task;
	return {
		taskId,
		expectedRevision: t.revision,
		authorityEpoch: t.authorityEpoch,
		executionGeneration: t.executionGeneration,
	};
}
async function finish(h: Harness, taskId: string) {
	await h.store.write((tx) =>
		h.tasks.applyTransitionInTransaction(tx, fence(h, taskId), {
			state: "active",
			phase: "implementing",
			reason: "fixture_started",
		}),
	);
	await h.store.write((tx) =>
		h.tasks.applyTransitionInTransaction(tx, fence(h, taskId), {
			state: "completed",
			phase: "finalizing",
			reason: "finished",
			result: {
				summary: "done",
				evidenceRefs: ["receipt:checks"],
				conditionsMet: [true],
			},
		}),
	);
}
/** Same aggregation as the tasks/0002-retention seed, evaluated from scratch. */
const recomputedBytes = (h: Harness) =>
	(
		h.store.read((db) =>
			db
				.query(`SELECT
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_tasks) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_questions) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))+length(CAST(origin_json AS BLOB))),0) FROM work_task_grants) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_events) +
 (SELECT coalesce(sum(length(CAST(receipt_json AS BLOB))+length(input_digest)),0) FROM work_task_commands) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_runtime) AS bytes`)
				.get(),
		) as { bytes: number }
	).bytes;
const count = (h: Harness, table: string) =>
	(
		h.store.read((db) =>
			db.query(`SELECT count(*) AS n FROM ${table}`).get(),
		) as { n: number }
	).n;
const ids = (h: Harness) =>
	h.store
		.read(
			(db) => db.query("SELECT id FROM work_tasks").all() as { id: string }[],
		)
		.map((r) => r.id);

test("finished tasks are deleted 90 days after finishing, so the lifetime task cap no longer blocks creation", async () => {
	const h = setup({ maxTasks: 3 });
	const created: string[] = [];
	for (let n = 0; n < 3; n++) {
		const r = await h.tasks.create(input());
		created.push(r.taskId);
		await finish(h, r.taskId);
	}
	await expect(h.tasks.create(input())).rejects.toThrow("task_capacity");
	h.clock.t += 31 * DAY;
	await h.tasks.maintenance();
	expect(ids(h)).toHaveLength(3);
	expect(h.tasks.get(created[0]!).task.metadataExpired).toBe(true);
	await expect(h.tasks.create(input())).rejects.toThrow("task_capacity");
	h.clock.t += 90 * DAY;
	await h.tasks.maintenance();
	expect(ids(h)).toHaveLength(0);
	for (const table of [
		"work_task_grants",
		"work_task_commands",
		"work_task_events",
		"work_task_questions",
		"work_task_runtime",
	])
		expect(count(h, table)).toBe(0);
	expect(h.store.read(capacity).bytes).toBe(0);
	await h.tasks.create(input());
	expect(ids(h)).toHaveLength(1);
});
test("work_task_storage stays equal to a full recount across every kind of write", async () => {
	const h = setup();
	const a = await h.tasks.create(input());
	const b = await h.tasks.create(input());
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	await h.store.write((tx) => {
		const t = h.tasks.getInTransaction(tx, a.taskId)!;
		putQuestion(tx, {
			id: "q1",
			taskId: t.id,
			state: "open",
			text: "which file?",
		} as never);
		putQuestion(tx, {
			id: "q1",
			taskId: t.id,
			state: "answered",
			text: "which file? answered with a longer text",
		} as never);
		h.tasks.setRuntimeInTransaction(tx, t.id, { scheduleId: "s1" });
		h.tasks.setRuntimeInTransaction(tx, t.id, { observeJobId: "j1" });
	});
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	const current = h.tasks.get(a.taskId).task;
	await h.tasks.amend(a.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: current.revision,
		grant: { ...current.grant, operations: ["read", "edit"] },
	});
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	await finish(h, b.taskId);
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	h.clock.t += 121 * DAY;
	await h.tasks.maintenance();
	expect(ids(h)).toEqual([a.taskId]);
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	expect(h.store.read(capacity).bytes).toBeGreaterThan(0);
});
test("a failing purge hook keeps only that task; the others are deleted and the failure is retried", async () => {
	let poisoned = "";
	const calls: string[] = [];
	const h = setup({}, (_tx, t) => {
		calls.push(t.id);
		if (t.id === poisoned) throw new Error("purge_fixture_failed");
	});
	const made: string[] = [];
	for (let n = 0; n < 3; n++) {
		const r = await h.tasks.create(input());
		made.push(r.taskId);
		await finish(h, r.taskId);
	}
	poisoned = made[1]!;
	h.clock.t += 31 * DAY;
	await h.tasks.maintenance();
	h.clock.t += 90 * DAY;
	await h.tasks.maintenance();
	expect(ids(h)).toEqual([poisoned]);
	expect(h.tasks.get(poisoned).task.state).toBe("completed");
	expect(h.store.read(capacity).bytes).toBe(recomputedBytes(h));
	poisoned = "";
	calls.length = 0;
	// A failed purge is skipped for a while, then retried.
	await h.tasks.maintenance();
	expect(calls).toEqual([]);
	h.clock.t += 2 * 3_600_000;
	await h.tasks.maintenance();
	expect(calls).toEqual([made[1]!]);
	expect(ids(h)).toHaveLength(0);
});
test("fifty permanently failing oldest purges do not starve newer finished tasks", async () => {
	const failing = new Set<string>();
	const h = setup({}, (_tx, t) => {
		if (failing.has(t.id)) throw new Error("purge_fixture_failed");
	});
	const made: string[] = [];
	for (let n = 0; n < 51; n++) {
		const r = await h.tasks.create(input());
		made.push(r.taskId);
		await finish(h, r.taskId);
		if (n < 50) failing.add(r.taskId);
		h.clock.t += 1;
	}
	h.clock.t += 31 * DAY;
	await h.tasks.maintenance();
	h.clock.t += 90 * DAY;
	await h.tasks.maintenance();
	// The first batch is the 50 failures; they are then skipped, not retried.
	expect(ids(h)).toHaveLength(51);
	await h.tasks.maintenance();
	expect(ids(h)).not.toContain(made[50]!);
	expect(ids(h)).toHaveLength(50);
	await h.tasks.maintenance();
	expect(ids(h)).toHaveLength(50);
	failing.clear();
	h.clock.t += 2 * 3_600_000;
	await h.tasks.maintenance();
	expect(ids(h)).toHaveLength(0);
});
test("the kind-independent purge hook removes dependents even when no kind is registered", async () => {
	const h = setup();
	await h.store.write((tx) =>
		tx.exec(
			"CREATE TABLE fx_child(task_id TEXT NOT NULL REFERENCES work_tasks(id))",
		),
	);
	const done = await h.tasks.create(input());
	await finish(h, done.taskId);
	await h.store.write((tx) =>
		tx.query("INSERT INTO fx_child(task_id) VALUES(?)").run(done.taskId),
	);
	// A process without the coding kind (no runner configured) still owns the purge.
	const bare = createTasks(h.store, {
		now: () => h.clock.t,
		purgeInTransaction: (tx, t) =>
			tx.query("DELETE FROM fx_child WHERE task_id=?").run(t.id),
	});
	h.clock.t += 31 * DAY;
	await bare.maintenance();
	h.clock.t += 90 * DAY;
	await bare.maintenance();
	expect(ids(h)).toEqual([]);
	expect(count(h, "fx_child")).toBe(0);
});
test("a task whose dependents were already purged is deleted without error, and a task with undeletable dependents stays", async () => {
	const h = setup({}, (tx, t) => {
		// Idempotent, like coding-supervision's purge: zero rows is not a failure.
		tx.query("DELETE FROM fx_child WHERE task_id=?").run(t.id);
	});
	await h.store.write((tx) =>
		tx.exec(
			"CREATE TABLE fx_child(task_id TEXT NOT NULL REFERENCES work_tasks(id))",
		),
	);
	const done = await h.tasks.create(input());
	const kept = await h.tasks.create(input());
	await finish(h, done.taskId);
	await finish(h, kept.taskId);
	// `done` was purged earlier (body expiry); `kept` still has a dependent row.
	await h.store.write((tx) =>
		tx.query("INSERT INTO fx_child(task_id) VALUES(?)").run(kept.taskId),
	);
	h.clock.t += 31 * DAY;
	await h.tasks.maintenance();
	h.clock.t += 90 * DAY;
	await h.tasks.maintenance();
	expect(ids(h)).toEqual([]);
	expect(count(h, "fx_child")).toBe(0);
});
test("opening a database that only has tasks/0001-init seeds the byte total from existing rows", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-tasks-retention-"));
	dirs.push(dir);
	const file = join(dir, "db");
	const old = openStore(file, [{ id: "tasks/0001-init", sql: initSql }]);
	await old.write((tx) => {
		tx.query(
			"INSERT INTO work_tasks(id,state,data_json,finished_ms) VALUES(?,?,?,?)",
		).run("t1", "completed", JSON.stringify({ id: "t1", title: "あ" }), 1);
		tx.query(
			"INSERT INTO work_task_events(task_id,seq,data_json) VALUES(?,?,?)",
		).run("t1", 1, '{"seq":1}');
		tx.query(
			"INSERT INTO work_task_grants(task_id,epoch,data_json,origin_json) VALUES(?,?,?,?)",
		).run("t1", 1, '{"g":1}', '{"o":1}');
		tx.query(
			"INSERT INTO work_task_commands(scope,request_id,input_digest,task_id,receipt_json) VALUES(?,?,?,?,?)",
		).run("s", "r", "digest", "t1", '{"receipt":1}');
	});
	await old.close();
	const store = openStore(file, migrations);
	stores.push(store);
	const bytes = store.read(capacity).bytes;
	const expected =
		Buffer.byteLength(JSON.stringify({ id: "t1", title: "あ" })) +
		Buffer.byteLength('{"seq":1}') +
		Buffer.byteLength('{"g":1}') +
		Buffer.byteLength('{"o":1}') +
		Buffer.byteLength('{"receipt":1}') +
		Buffer.byteLength("digest");
	expect(bytes).toBe(expected);
	// Triggers are live after the migration.
	await store.write((tx) =>
		tx.query("DELETE FROM work_task_events WHERE task_id='t1'").run(),
	);
	expect(store.read(capacity).bytes).toBe(
		expected - Buffer.byteLength('{"seq":1}'),
	);
});
