import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../../queue";
import { createScheduler, migration, type TargetDefinition } from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const MIN = 60_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

function setup(options: { maxSchedules?: number; queueLimit?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-scheduler-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [queueMigration, migration]);
	stores.push(store);
	const clock = { t: T0 };
	const queue = createQueue(store, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
		limits: options.queueLimit
			? {
					total: options.queueLimit,
					background: options.queueLimit,
					scope: options.queueLimit,
				}
			: undefined,
	});
	// The job never runs in these tests; it only needs to exist and stay open.
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
	const control = { fail: false, materialized: [] as string[] };
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
			if (control.fail) throw new Error("boom");
			control.materialized.push(occurrence.occurrenceId);
			return { jobId: job.id, subjectRef: occurrence.occurrenceId };
		},
	};
	const scheduler = createScheduler(store, queue, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
		maxSchedules: options.maxSchedules,
	});
	scheduler.registerTarget(target);
	return { store, queue, scheduler, clock, control };
}
const iso = (ms: number) => new Date(ms).toISOString();
const create = (
	h: ReturnType<typeof setup>,
	schedule: Parameters<
		ReturnType<typeof setup>["scheduler"]["create"]
	>[0]["schedule"],
	extra: Record<string, unknown> = {},
) =>
	h.scheduler.create({
		requestId: crypto.randomUUID(),
		target: { kind: "test.target", payload: { label: "x" } },
		schedule,
		misfirePolicy: "coalesce",
		graceMs: 5 * MIN,
		...extra,
	} as never);
const jobs = (h: ReturnType<typeof setup>) => h.queue.list().items;
const finishJobs = (h: ReturnType<typeof setup>) =>
	h.store.write((db) =>
		db
			.query("UPDATE queue_jobs SET state='completed' WHERE state='queued'")
			.run(),
	);

test("once: nothing before the time, exactly one job after, completed state is not job success", async () => {
	const h = setup();
	const s = await create(h, { type: "once", at: iso(T0 + 10 * MIN) });
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(0);
	h.clock.t += 10 * MIN;
	await h.scheduler.tick();
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(1);
	expect(h.scheduler.get(s.id)?.state).toBe("completed");
	const occ = h.scheduler.listOccurrences(s.id).items;
	expect(occ).toHaveLength(1);
	expect(occ[0]?.state).toBe("dispatched");
	expect(occ[0]?.jobState).toBe("queued");
});

test("offsets are required and interval bounds enforced by the API schema", async () => {
	const { createScheduleSchema } = await import("../contracts");
	const base = {
		requestId: crypto.randomUUID(),
		target: { kind: "k", payload: {} },
	};
	expect(
		createScheduleSchema.safeParse({
			...base,
			schedule: { type: "once", at: "2026-01-01T09:00:00" },
		}).success,
	).toBe(false);
	expect(
		createScheduleSchema.safeParse({
			...base,
			schedule: { type: "once", at: "2026-01-01T09:00:00+09:00" },
		}).success,
	).toBe(true);
	expect(
		createScheduleSchema.safeParse({
			...base,
			schedule: {
				type: "interval",
				anchor: "2026-01-01T00:00:00Z",
				intervalMs: 1000,
			},
		}).success,
	).toBe(false);
});

test("interval keeps phase, fires once per period, and ignores duplicate ticks and clock going back", async () => {
	const h = setup();
	const s = await create(h, {
		type: "interval",
		anchor: iso(T0 + 5 * MIN),
		intervalMs: 10 * MIN,
	});
	h.clock.t = T0 + 5 * MIN + 30_000;
	await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
	expect(jobs(h)).toHaveLength(1);
	await finishJobs(h);
	h.clock.t -= 20 * MIN; // clock moves backwards
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(1);
	h.clock.t = T0 + 15 * MIN + 1000;
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(2);
	const dues = h.scheduler
		.listOccurrences(s.id)
		.items.map((o) => Date.parse(o.scheduledAt));
	expect(dues.sort()).toEqual([T0 + 5 * MIN, T0 + 15 * MIN]);
	expect(Date.parse(h.scheduler.get(s.id)?.nextDueAt ?? "")).toBe(
		T0 + 25 * MIN,
	);
});

test("long stop: coalesce creates one occurrence and advances into the future", async () => {
	const h = setup();
	const s = await create(h, {
		type: "interval",
		anchor: iso(T0 + MIN),
		intervalMs: MIN,
	});
	h.clock.t = T0 + 500 * MIN + 10_000;
	await h.scheduler.tick();
	const occ = h.scheduler.listOccurrences(s.id).items;
	expect(occ).toHaveLength(1);
	expect(occ[0]?.reason).toContain("coalesced");
	expect(Date.parse(h.scheduler.get(s.id)?.nextDueAt ?? "")).toBeGreaterThan(
		h.clock.t,
	);
});

test("skip policy: late beyond grace is skipped and summarised; within grace dispatches", async () => {
	const h = setup();
	const s = await create(
		h,
		{ type: "interval", anchor: iso(T0 + MIN), intervalMs: 10 * MIN },
		{ misfirePolicy: "skip", graceMs: 2 * MIN },
	);
	h.clock.t = T0 + 100 * MIN;
	await h.scheduler.tick();
	let occ = h.scheduler.listOccurrences(s.id).items;
	expect(occ[0]?.state).toBe("skipped");
	expect(occ[0]?.reason).toContain("misfire_skipped");
	expect(jobs(h)).toHaveLength(0);
	h.clock.t = Date.parse(h.scheduler.get(s.id)?.nextDueAt ?? "") + MIN;
	await h.scheduler.tick();
	occ = h.scheduler.listOccurrences(s.id).items;
	expect(occ[0]?.state).toBe("dispatched");
});

test("overlap: previous open job makes the next occurrence skipped without touching the job", async () => {
	const h = setup();
	const s = await create(h, {
		type: "interval",
		anchor: iso(T0),
		intervalMs: MIN,
	});
	await h.scheduler.tick();
	h.clock.t += MIN;
	await h.scheduler.tick();
	const occ = h.scheduler.listOccurrences(s.id).items;
	expect(occ.map((o) => o.reason ?? o.state)).toEqual([
		"overlap",
		"dispatched",
	]);
	expect(jobs(h)).toHaveLength(1);
	expect(jobs(h)[0]?.state).toBe("queued");
	await finishJobs(h);
	h.clock.t += MIN;
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(2);
});

test("pause/resume/cancel with revisions; resume skips stopped periods; cancelled never revives", async () => {
	const h = setup();
	const s = await create(h, {
		type: "interval",
		anchor: iso(T0),
		intervalMs: 10 * MIN,
	});
	const paused = await h.scheduler.pause(s.id, s.revision);
	expect(paused?.state).toBe("paused");
	await expect(h.scheduler.pause(s.id, s.revision)).rejects.toThrow(
		"revision_conflict",
	);
	h.clock.t = T0 + 95 * MIN;
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(0);
	const resumed = await h.scheduler.resume(s.id, paused?.revision ?? -1);
	expect(Date.parse(resumed?.nextDueAt ?? "")).toBe(T0 + 100 * MIN);
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(0);
	const cancelled = await h.scheduler.cancel(s.id, resumed?.revision ?? -1);
	expect(cancelled?.state).toBe("cancelled");
	await expect(
		h.scheduler.resume(s.id, cancelled?.revision ?? -1),
	).rejects.toThrow("schedule_state_conflict");
	h.clock.t += 60 * MIN;
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(0);
});

test("materialize failure rolls back job and occurrence; queue full keeps the schedule due and retries", async () => {
	const h = setup({ queueLimit: 1 });
	const s = await create(h, { type: "once", at: iso(T0) });
	h.control.fail = true;
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(0); // enqueued job rolled back with the failure
	expect(h.scheduler.listOccurrences(s.id).items[0]?.reason).toBe(
		"target_failed",
	);

	const q = await create(h, { type: "once", at: iso(T0) });
	h.control.fail = false;
	const filler = await create(h, { type: "once", at: iso(T0) });
	await h.scheduler.tick(); // first dispatch fills the queue (limit 1)
	await h.scheduler.tick();
	const states = [q, filler].map((x) => h.scheduler.get(x.id));
	expect(states.filter((x) => x?.state === "active")).toHaveLength(1);
	expect(states.find((x) => x?.state === "active")?.deferReason).toBe(
		"queue_full",
	);
	expect(jobs(h)).toHaveLength(1);
	await finishJobs(h);
	h.clock.t += 10_000; // past the capacity backoff
	await h.scheduler.tick();
	expect(jobs(h)).toHaveLength(2);
	expect([q, filler].map((x) => h.scheduler.get(x.id)?.state)).toEqual([
		"completed",
		"completed",
	]);
});

test("create is idempotent per requestId, conflicts on different input, validates target and caps count", async () => {
	const h = setup({ maxSchedules: 2 });
	const requestId = crypto.randomUUID();
	const input = {
		requestId,
		target: { kind: "test.target", payload: { label: "a" } },
		schedule: { type: "once" as const, at: iso(T0 + MIN) },
		misfirePolicy: "coalesce" as const,
		graceMs: 1000,
	};
	const a = await h.scheduler.create(input);
	expect((await h.scheduler.create(input)).id).toBe(a.id);
	await expect(
		h.scheduler.create({
			...input,
			target: { kind: "test.target", payload: { label: "b" } },
		}),
	).rejects.toThrow("request_conflict");
	await expect(
		h.scheduler.create({
			...input,
			requestId: crypto.randomUUID(),
			target: { kind: "nope", payload: {} },
		}),
	).rejects.toThrow("invalid_unknown_target");
	await expect(
		h.scheduler.create({
			...input,
			requestId: crypto.randomUUID(),
			target: { kind: "test.target", payload: {} },
		}),
	).rejects.toThrow("invalid_target_payload");
	await h.scheduler.create({ ...input, requestId: crypto.randomUUID() });
	await expect(
		h.scheduler.create({ ...input, requestId: crypto.randomUUID() }),
	).rejects.toThrow("schedule_limit_reached");
});

test("tick processes at most the configured batch", async () => {
	const h = setup();
	const s = createScheduler(h.store, h.queue, {
		now: () => h.clock.t,
		sleep: () => new Promise(() => {}),
		tickLimit: 2,
	});
	s.registerTarget({
		kind: "t2",
		version: 1,
		schema: z.object({}),
		materializeInTransaction: (tx, o) => {
			const { job } = h.queue.enqueueInTransaction(tx, {
				scope: "sched",
				kind: "test.job",
				dedupeKey: o.occurrenceId,
				payload: { occurrenceId: o.occurrenceId },
				lane: "background",
			});
			return { jobId: job.id, subjectRef: null };
		},
	});
	for (let i = 0; i < 5; i++)
		await s.create({
			requestId: crypto.randomUUID(),
			target: { kind: "t2", payload: {} },
			schedule: { type: "once", at: iso(T0) },
			misfirePolicy: "coalesce",
			graceMs: 1000,
		});
	expect(await s.tick()).toBe(2);
	expect(jobs(h)).toHaveLength(2);
});

test("deferred schedules cannot hide later due schedules beyond one candidate page", async () => {
	const h = setup();
	const unavailable = {
		kind: "unavailable.target",
		version: 1,
		schema: z.object({}),
		materializeInTransaction: () => {
			throw new Error("should_not_run");
		},
	};
	h.scheduler.registerTarget(unavailable);
	for (let i = 0; i < 128; i++)
		await h.scheduler.create({
			requestId: crypto.randomUUID(),
			target: { kind: unavailable.kind, payload: {} },
			schedule: { type: "once", at: iso(T0) },
			misfirePolicy: "coalesce",
			graceMs: 1000,
		});
	unavailable.version = 2;
	const later = await create(h, { type: "once", at: iso(T0) });
	for (let i = 0; i < 5; i++) await h.scheduler.tick();
	expect(h.scheduler.get(later.id)?.state).toBe("completed");
	expect(jobs(h)).toHaveLength(1);
});
