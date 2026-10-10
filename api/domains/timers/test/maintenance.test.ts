import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migration as queueMigration, createQueue } from "../../queue";
import type { QueueService } from "../../queue";
import {
	migration as schedulerMigration,
	createScheduler,
} from "../../scheduler";
import { createTimers } from "..";
import { migrations as timerMigrations } from "../repository";
import { TIMER_POLICY } from "../service/policy";

const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const issued = "2026-10-09T00:00:00.000Z";

async function open(options: { failExpiry?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-timers-maint-"));
	let now = T0;
	const store = openStore(join(dir, "db.sqlite3"), [
		queueMigration,
		schedulerMigration,
		...timerMigrations,
	]);
	const queue = createQueue(store, { now: () => now });
	const scheduler = createScheduler(store, queue, { now: () => now });
	const failingQueue: QueueService = options.failExpiry
		? {
				...queue,
				registerHandler: (definition) =>
					queue.registerHandler({
						...definition,
						async execute() {
							throw new Error("boom");
						},
					} as typeof definition),
			}
		: queue;
	const timers = createTimers(
		store,
		{ queue: failingQueue, scheduler },
		{ now: () => now, publish() {} },
	);
	return {
		store,
		queue,
		scheduler,
		timers,
		setNow(ms: number) {
			now = ms;
		},
		async close() {
			await queue.close();
			await scheduler.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function startBody(durationSeconds: number) {
	return { requestId: crypto.randomUUID(), issuedAt: issued, durationSeconds };
}

function jobCount(h: Awaited<ReturnType<typeof open>>) {
	return h.queue.list({ kind: "timer.expire" }, null, 100).items.length;
}

test("a deterministically failing expiry backs off, stops at redispatchMax and notifies once", async () => {
	const h = await open({ failExpiry: true });
	try {
		const started = await h.timers.start(startBody(1));
		if (started.receipt.action !== "started") throw new Error("expected start");
		const timerId = started.receipt.timer.id;
		let now = T0 + 1000;
		const redispatchAt: number[] = [];
		let last = 0;
		for (let step = 0; step < 4000; step++) {
			h.setNow(now);
			await h.scheduler.tick();
			await h.timers.maintenance();
			for (let i = 0; i < 4; i++) await h.queue.tick();
			const n = jobCount(h);
			if (n !== last) {
				redispatchAt.push(now);
				last = n;
			}
			if (h.timers.get(timerId)?.timer.state === "elapsed") break;
			now += 1000;
		}
		const view = h.timers.get(timerId)!;
		expect(view.timer.state).toBe("elapsed");
		expect(view.timer.errorCode).toBe("timer_dispatch_exhausted");
		const jobs = jobCount(h);
		expect(jobs).toBeLessThanOrEqual(TIMER_POLICY.redispatchMax);
		const gaps = redispatchAt.slice(1).map((t, i) => t - redispatchAt[i]!);
		for (let i = 1; i < gaps.length; i++)
			expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
		const notes = h.timers
			.notifications()
			.items.filter((n) => n.timerId === timerId);
		expect(notes).toHaveLength(1);
		expect(notes[0]!.status).toBe("pending");
		for (let i = 0; i < 5; i++) {
			now += 1000;
			h.setNow(now);
			await h.timers.maintenance();
			await h.queue.tick();
		}
		expect(jobCount(h)).toBe(jobs);
		expect(
			h.timers.notifications().items.filter((n) => n.timerId === timerId),
		).toHaveLength(1);
	} finally {
		await h.close();
	}
});

test("prune runs about once per pruneEveryMs while maintenance runs every second", async () => {
	const h = await open();
	try {
		const seed = (id: string, createdAt: number) =>
			h.store.write((db) => {
				db.query(
					`INSERT INTO timer_operations (id, scope, request_id, issued_at_ms, input_digest, operation, timer_id, origin_key, receipt_json, receipt_digest, created_at_ms)
         VALUES (?, 'default', ?, 0, 'd', 'list', NULL, NULL, '{}', 'd', ?)`,
				).run(id, id, createdAt);
			});
		const count = () =>
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM timer_operations WHERE operation='list' AND id LIKE 'seed-%'",
							)
							.get() as { n: number }
					).n,
			);
		await seed("seed-1", T0 - TIMER_POLICY.listRetentionMs - 10);
		h.setNow(T0);
		await h.timers.maintenance(); // first call prunes
		expect(count()).toBe(0);
		await seed("seed-2", T0 - TIMER_POLICY.listRetentionMs - 10);
		for (let s = 1; s < 59; s++) {
			h.setNow(T0 + s * 1000);
			await h.timers.maintenance();
		}
		expect(count()).toBe(1); // throttled
		h.setNow(T0 + 60_000);
		await h.timers.maintenance();
		expect(count()).toBe(0);
	} finally {
		await h.close();
	}
});

test("list operations do not consume start capacity and expire after listRetentionMs", async () => {
	const h = await open();
	try {
		await h.store.write((db) => {
			const stmt = db.query(
				`INSERT INTO timer_operations (id, scope, request_id, issued_at_ms, input_digest, operation, timer_id, origin_key, receipt_json, receipt_digest, created_at_ms)
         VALUES (?, 'default', ?, 0, 'd', 'list', NULL, NULL, '{}', 'd', ?)`,
			);
			for (let i = 0; i < TIMER_POLICY.maxOperations + 10; i++)
				stmt.run(`l-${i}`, `l-${i}`, T0);
		});
		const started = await h.timers.start(startBody(60));
		expect(started.receipt.action).toBe("started");
		// start/cancel receipts stay until retentionMs; list rows go after listRetentionMs
		h.setNow(T0 + TIMER_POLICY.listRetentionMs + 1000);
		await h.timers.maintenance();
		const counts = h.store.read((db) => ({
			list: (
				db
					.query(
						"SELECT COUNT(*) AS n FROM timer_operations WHERE operation='list'",
					)
					.get() as { n: number }
			).n,
			other: (
				db
					.query(
						"SELECT COUNT(*) AS n FROM timer_operations WHERE operation!='list'",
					)
					.get() as { n: number }
			).n,
		}));
		expect(counts.other).toBe(1);
		expect(counts.list).toBeLessThan(TIMER_POLICY.maxOperations + 10);
	} finally {
		await h.close();
	}
});

test("prune queries use the retention indexes", async () => {
	const h = await open();
	try {
		const plan = h.store.read((db) =>
			db
				.query(
					`EXPLAIN QUERY PLAN SELECT id FROM timer_operations
           WHERE receipt_json IS NOT NULL AND created_at_ms<=?
           ORDER BY created_at_ms ASC, id ASC LIMIT ?`,
				)
				.all(0, 10)
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		expect(plan).toContain("timer_operations_live");
	} finally {
		await h.close();
	}
});
