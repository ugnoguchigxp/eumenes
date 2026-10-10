import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../../queue";
import { createScheduler, migration, type TargetDefinition } from "..";
import { lastDispatchedJob } from "../repository";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-scheduler-retention-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [queueMigration, migration]);
	stores.push(store);
	const clock = { t: T0 };
	const queue = createQueue(store, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
	});
	queue.registerHandler({
		kind: "test.job",
		payloadVersions: [1],
		schema: z.object({ occurrenceId: z.string() }),
		recovery: "interrupt",
		prepareInTransaction: () => ({ status: "ready", input: null }),
		execute: () => new Promise(() => {}),
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
	const target: TargetDefinition<{ label: string }> = {
		kind: "test.target",
		version: 1,
		schema: z.object({ label: z.string() }),
		materializeInTransaction(tx, occurrence) {
			const { job } = queue.enqueueInTransaction(tx, {
				scope: "sched",
				kind: "test.job",
				dedupeKey: occurrence.occurrenceId,
				payload: { occurrenceId: occurrence.occurrenceId },
				subjectRef: occurrence.occurrenceId,
				lane: "background",
			});
			return { jobId: job.id, subjectRef: occurrence.occurrenceId };
		},
	};
	const scheduler = createScheduler(store, queue, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
	});
	scheduler.registerTarget(target);
	const create = (schedule: Record<string, unknown>) =>
		scheduler.create({
			requestId: crypto.randomUUID(),
			target: { kind: "test.target", payload: { label: "x" } },
			schedule,
			misfirePolicy: "coalesce",
			graceMs: 5 * MIN,
		} as never);
	const prune = (at: number) =>
		store.write((db) => scheduler.pruneInTransaction(db, at));
	const count = (table: string) =>
		store.read(
			(db) =>
				(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
					.n,
		);
	return { store, scheduler, clock, create, prune, count };
}

test("old occurrences of an active schedule are pruned; the latest dispatched one stays", async () => {
	const h = setup();
	const s = await h.create({
		type: "interval",
		anchor: iso(T0),
		intervalMs: MIN,
	});
	// The first job stays open, so later ticks are skipped for overlap.
	for (let i = 0; i < 4; i++) {
		h.clock.t = T0 + i * MIN + 1000;
		await h.scheduler.tick();
	}
	expect(h.count("scheduler_occurrences")).toBe(4);
	const before = h.store.read((db) => lastDispatchedJob(db, s.id));
	expect(before).not.toBeNull();
	await h.prune(T0 + 20 * DAY);
	// seq 1 (latest dispatched) and seq 4 (highest seq) remain.
	expect(h.count("scheduler_occurrences")).toBe(2);
	expect(h.store.read((db) => lastDispatchedJob(db, s.id))).toBe(before);
	expect(h.scheduler.get(s.id)?.state).toBe("active");
});

test("recent occurrences are not pruned", async () => {
	const h = setup();
	await h.create({ type: "interval", anchor: iso(T0), intervalMs: MIN });
	for (let i = 0; i < 3; i++) {
		h.clock.t = T0 + i * MIN + 1000;
		await h.scheduler.tick();
	}
	await h.prune(T0 + 13 * DAY);
	expect(h.count("scheduler_occurrences")).toBe(3);
});

test("a schedule cancelled more than 30 days ago is deleted with its occurrences; 29 days stays", async () => {
	const h = setup();
	const a = await h.create({
		type: "interval",
		anchor: iso(T0),
		intervalMs: MIN,
	});
	h.clock.t = T0 + 1000;
	await h.scheduler.tick();
	await h.scheduler.cancel(a.id, h.scheduler.get(a.id)!.revision);
	expect(h.scheduler.get(a.id)?.state).toBe("cancelled");
	await h.create({ type: "interval", anchor: iso(T0), intervalMs: MIN });
	await h.prune(T0 + 29 * DAY);
	expect(h.scheduler.get(a.id)).not.toBeNull();
	expect(h.count("scheduler_schedules")).toBe(2);
	await h.prune(T0 + 31 * DAY);
	expect(h.scheduler.get(a.id)).toBeNull();
	expect(h.count("scheduler_schedules")).toBe(1);
	expect(h.count("scheduler_occurrences")).toBe(0);
});
