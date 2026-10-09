import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migration as queueMigration, createQueue } from "../../queue";
import {
	migration as schedulerMigration,
	createScheduler,
} from "../../scheduler";
import {
	createTimers,
	migration as timerMigration,
	startTimerSchema,
	type TimersService,
} from "..";
import type { QueueService } from "../../queue";
import type { SchedulerService } from "../../scheduler";

const T0 = Date.parse("2026-10-09T00:00:00.000Z");

export async function openTimers(options?: {
	now?: () => number;
	queueLimits?: { total: number; background: number; scope: number };
	protectedIds?: (tx: import("bun:sqlite").Database) => readonly string[];
}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-timers-"));
	let clock = options?.now ?? (() => T0);
	const store = openStore(join(dir, "db.sqlite3"), [
		queueMigration,
		schedulerMigration,
		timerMigration,
	]);
	const queue = createQueue(store, {
		now: () => clock(),
		limits: options?.queueLimits,
	});
	const scheduler = createScheduler(store, queue, { now: () => clock() });
	const timers = createTimers(
		store,
		{ queue, scheduler },
		{
			now: () => clock(),
			protectedIds: options?.protectedIds,
			publish() {},
		},
	);
	return {
		dir,
		store,
		queue,
		scheduler,
		timers,
		setNow(ms: number) {
			clock = () => ms;
		},
		async close() {
			await queue.close();
			await scheduler.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const issued = "2026-10-09T00:00:00.000Z";

export function startBody(
	durationSeconds: number,
	requestId = crypto.randomUUID(),
) {
	return {
		requestId,
		issuedAt: issued,
		durationSeconds,
	};
}

test("duration bounds reject 0, 86401, fractions and NaN; 1 and 86400 pass", () => {
	expect(startTimerSchema.safeParse(startBody(0)).success).toBe(false);
	expect(startTimerSchema.safeParse(startBody(86401)).success).toBe(false);
	expect(startTimerSchema.safeParse(startBody(1.5)).success).toBe(false);
	expect(startTimerSchema.safeParse(startBody(Number.NaN)).success).toBe(false);
	expect(startTimerSchema.safeParse(startBody(1)).success).toBe(true);
	expect(startTimerSchema.safeParse(startBody(86400)).success).toBe(true);
	expect(
		startTimerSchema.safeParse({ ...startBody(180), label: "a".repeat(80) })
			.success,
	).toBe(true);
	expect(
		startTimerSchema.safeParse({ ...startBody(180), label: "a".repeat(81) })
			.success,
	).toBe(false);
	expect(
		startTimerSchema.safeParse({ ...startBody(180), label: "   " }).success,
	).toBe(false);
	expect(
		startTimerSchema.safeParse({ ...startBody(180), scope: "other" }).success,
	).toBe(false);
	expect(
		startTimerSchema.safeParse({
			...startBody(180),
			issuedAt: "2026-10-09T00:00:00",
		}).success,
	).toBe(false);
});

test("180 second start fixes dueAt, replays the same receipt, and rolls back with the schedule", async () => {
	const h = await openTimers();
	try {
		const body = startBody(180);
		const first = await h.timers.start(body);
		expect(first.replay).toBe(false);
		expect(first.receipt.action).toBe("started");
		if (first.receipt.action !== "started") return;
		expect(first.receipt.timer.durationSeconds).toBe(180);
		expect(first.receipt.timer.dueAt).toBe("2026-10-09T00:03:00.000Z");
		expect(first.receipt.timer.remainingSeconds).toBe(180);
		expect(first.receipt.artifact.timerId).toBe(first.receipt.timer.id);
		const again = await h.timers.start(body);
		expect(again.replay).toBe(true);
		expect(again.receipt).toEqual(first.receipt);
		const rows = h.store.read(
			(db) =>
				db.query("SELECT COUNT(*) AS n FROM timers").get() as { n: number },
		);
		expect(rows.n).toBe(1);
		const schedules = h.scheduler.list();
		expect(schedules.items).toHaveLength(1);
		await expect(
			h.timers.start({ ...body, durationSeconds: 90 }),
		).rejects.toThrow("request_conflict");
		expect(
			h.store.read(
				(db) =>
					db.query("SELECT COUNT(*) AS n FROM timers").get() as { n: number },
			).n,
		).toBe(1);
	} finally {
		await h.close();
	}
});

test("a scheduler rejection rolls the timer and the operation back together", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-timers-rollback-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		queueMigration,
		schedulerMigration,
		timerMigration,
	]);
	const queue = createQueue(store, { now: () => T0 });
	const scheduler = createScheduler(store, queue, { now: () => T0 });
	const failing = {
		...scheduler,
		createInTransaction() {
			throw new Error("schedule_limit_reached");
		},
	};
	const timers = createTimers(
		store,
		{ queue, scheduler: failing },
		{ now: () => T0 },
	);
	try {
		await expect(timers.start(startBody(180))).rejects.toThrow(
			"schedule_limit_reached",
		);
		const counts = store.read((db) => ({
			timers: (
				db.query("SELECT COUNT(*) AS n FROM timers").get() as { n: number }
			).n,
			ops: (
				db.query("SELECT COUNT(*) AS n FROM timer_operations").get() as {
					n: number;
				}
			).n,
			schedules: (
				db.query("SELECT COUNT(*) AS n FROM scheduler_schedules").get() as {
					n: number;
				}
			).n,
		}));
		expect(counts).toEqual({ timers: 0, ops: 0, schedules: 0 });
	} finally {
		await queue.close();
		await scheduler.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cancel of an active timer invalidates the schedule and a later expiry does not adopt it", async () => {
	const h = await openTimers();
	try {
		const started = await h.timers.start(startBody(180));
		if (started.receipt.action !== "started") throw new Error("expected start");
		const cancelled = await h.timers.cancel(started.receipt.timer.id, {
			requestId: crypto.randomUUID(),
			issuedAt: issued,
			expectedRevision: started.receipt.timer.revision,
		});
		expect(cancelled.receipt.action).toBe("cancelled");
		if (cancelled.receipt.action !== "cancelled") return;
		expect(cancelled.receipt.timer.state).toBe("cancelled");
		expect(cancelled.receipt.timer.remainingSeconds).toBe(180);
		h.setNow(T0 + 180_000);
		await h.scheduler.tick();
		const timer = h.timers.get(started.receipt.timer.id);
		expect(timer?.timer.state).toBe("cancelled");
		expect(h.timers.notifications().items).toHaveLength(0);
		await expect(
			h.timers.cancel(started.receipt.timer.id, {
				requestId: crypto.randomUUID(),
				issuedAt: issued,
				expectedRevision: started.receipt.timer.revision,
			}),
		).rejects.toThrow("revision_conflict");
		const same = await h.timers.cancel(started.receipt.timer.id, {
			requestId: cancelled.receipt.operationId
				? (
						h.store.read((db) =>
							db
								.query("SELECT request_id FROM timer_operations WHERE id=?")
								.get(cancelled.receipt.operationId),
						) as { request_id: string }
					).request_id
				: crypto.randomUUID(),
			issuedAt: issued,
			expectedRevision: 0,
		});
		expect(same.replay).toBe(true);
	} finally {
		await h.close();
	}
});

test("due boundary: 179999 stays active, 180000 elapses with one notification", async () => {
	const h = await openTimers();
	try {
		const started = await h.timers.start(startBody(180));
		if (started.receipt.action !== "started") throw new Error("expected start");
		const timerId = started.receipt.timer.id;
		h.setNow(T0 + 179_999);
		await h.scheduler.tick();
		expect(h.timers.get(timerId)?.timer.state).toBe("active");
		expect(h.timers.notifications().items).toHaveLength(0);
		expect(h.timers.notifications().activeTimers).toBe(1);
		h.setNow(T0 + 180_000);
		await h.scheduler.tick();
		await settle(h.queue);
		const view = h.timers.get(timerId);
		expect(view?.timer.state).toBe("elapsed");
		expect(view?.timer.remainingSeconds).toBe(0);
		expect(h.timers.notifications().items).toHaveLength(1);
		expect(h.timers.notifications().activeTimers).toBe(0);
		const note = h.timers.notifications().items[0]!;
		expect(note.status).toBe("pending");
		await h.store.write((tx) => {
			const again = h.timers.handler.settleInTransaction(
				tx,
				{
					jobId: "ignored",
					scope: "default",
					kind: "timer.expire",
					payloadVersion: 1,
					payload: {
						timerId,
						cancelEpoch: 0,
						dispatchGeneration: 1,
					},
					subjectRef: timerId,
					owner: "test",
					attempt: 1,
					generation: 1,
					maxAttempts: 3,
					deadlineAtMs: null,
				},
				{
					id: timerId,
					epoch: 0,
					dispatchGeneration: 1,
				},
				{
					type: "success",
					result: { id: timerId, epoch: 0, dispatchGeneration: 1 },
				},
			);
			expect(again).toBe("stale");
		});
		expect(h.timers.notifications().items).toHaveLength(1);
	} finally {
		await h.close();
	}
});

async function settle(queue: QueueService) {
	for (let i = 0; i < 10; i++) {
		await queue.tick();
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (queue.stats().openJobs === 0) return;
	}
}

test("a fresh claim lease lasts 15s and a second client is rejected", async () => {
	const h = await openTimers();
	try {
		const started = await h.timers.start(startBody(180));
		if (started.receipt.action !== "started") throw new Error("expected start");
		h.setNow(T0 + 180_000);
		await h.scheduler.tick();
		await settle(h.queue);
		const note = h.timers.notifications().items[0]!;
		const clientA = crypto.randomUUID();
		const claimRequest = crypto.randomUUID();
		const claimed = await h.timers.claim(note.id, {
			clientId: clientA,
			claimRequestId: claimRequest,
			expectedRevision: note.revision,
		});
		expect(claimed.claimId).toBeTruthy();
		expect(claimed.leaseUntil).toBe("2026-10-09T00:03:15.000Z");
		const replay = await h.timers.claim(note.id, {
			clientId: clientA,
			claimRequestId: claimRequest,
			expectedRevision: 99,
		});
		expect(replay.claimId).toBe(claimed.claimId);
		await expect(
			h.timers.claim(note.id, {
				clientId: crypto.randomUUID(),
				claimRequestId: crypto.randomUUID(),
				expectedRevision: note.revision,
			}),
		).rejects.toThrow("notification_claimed");
		h.setNow(T0 + 180_000 + 300_001);
		await h.timers.maintenance();
		const stale = h.timers.notifications().items[0];
		expect(stale?.status).toBe("silent");
		expect(stale?.reason).toBe("stale");
	} finally {
		await h.close();
	}
});

test("origin retry keeps one timer and a different duration conflicts", async () => {
	const h = await openTimers();
	try {
		const origin = {
			scope: "default",
			conversationId: "c1",
			runId: crypto.randomUUID(),
			messageId: crypto.randomUUID(),
			originKey: "",
		};
		origin.originKey = `${origin.runId}:timer:0`;
		const command = { ...startBody(210), label: "休憩" };
		const first = await h.store.write((tx) =>
			h.timers.startInTransaction(tx, command, origin),
		);
		const second = await h.store.write((tx) =>
			h.timers.startInTransaction(
				tx,
				{ ...startBody(210, crypto.randomUUID()), label: "休憩" },
				origin,
			),
		);
		expect(second.replay).toBe(true);
		if (
			first.receipt.action !== "started" ||
			second.receipt.action !== "started"
		)
			throw new Error("expected start");
		expect(second.receipt.timer.id).toBe(first.receipt.timer.id);
		await expect(
			h.store.write((tx) =>
				h.timers.startInTransaction(tx, startBody(90), origin),
			),
		).rejects.toThrow("request_conflict");
	} finally {
		await h.close();
	}
});

void 0 as unknown as SqliteStore;
void 0 as unknown as SchedulerService;
void 0 as unknown as TimersService;

test("a replayed live claim becomes silent when it crosses the five minute freshness boundary", async () => {
	const h = await openTimers();
	try {
		await h.timers.start(startBody(1));
		h.setNow(T0 + 1000);
		await h.scheduler.tick();
		await settle(h.queue);
		const note = h.timers.notifications().items[0]!;
		h.setNow(T0 + 1000 + 299999);
		const input = {
			clientId: crypto.randomUUID(),
			claimRequestId: crypto.randomUUID(),
			expectedRevision: note.revision,
		};
		const first = await h.timers.claim(note.id, input);
		expect(first.claimId).toBeTruthy();
		h.setNow(T0 + 1000 + 300001);
		const replay = await h.timers.claim(note.id, input);
		expect(replay.claimId).toBeUndefined();
		expect(replay.notification.status).toBe("silent");
		expect(replay.notification.reason).toBe("stale");
	} finally {
		await h.close();
	}
});

test("acknowledgement replay belongs to the same client as the claim", async () => {
	const h = await openTimers();
	try {
		await h.timers.start(startBody(1));
		h.setNow(T0 + 1000);
		await h.scheduler.tick();
		await settle(h.queue);
		const note = h.timers.notifications().items[0]!;
		const clientId = crypto.randomUUID();
		const claimed = await h.timers.claim(note.id, {
			clientId,
			claimRequestId: crypto.randomUUID(),
			expectedRevision: note.revision,
		});
		const ack = {
			clientId,
			claimId: claimed.claimId!,
			outcome: "played" as const,
		};
		await h.timers.ack(note.id, ack);
		expect((await h.timers.ack(note.id, ack)).notification.status).toBe(
			"played",
		);
		await expect(
			h.timers.ack(note.id, { ...ack, clientId: crypto.randomUUID() }),
		).rejects.toThrow("claim_invalid");
	} finally {
		await h.close();
	}
});

test("a full expiry queue defers one timer without blocking recovery of an expired claim", async () => {
	const limits = { total: 128, background: 128, scope: 128 };
	const h = await openTimers({ queueLimits: limits });
	try {
		await h.timers.start(startBody(1));
		h.setNow(T0 + 1000);
		await h.scheduler.tick();
		await settle(h.queue);
		const note = h.timers.notifications().items[0]!;
		await h.timers.claim(note.id, {
			clientId: crypto.randomUUID(),
			claimRequestId: crypto.randomUUID(),
			expectedRevision: note.revision,
		});
		const second = await h.timers.start(startBody(1));
		if (second.receipt.action !== "started") throw new Error("expected start");
		const timerId = second.receipt.timer.id;
		await h.store.write((db) => {
			const timer = h.timers.readTimer(db, timerId)!;
			const schedule = h.scheduler.getInTransaction(db, timer.scheduleId!)!;
			h.scheduler.cancelInTransaction(db, schedule.id, schedule.revision);
		});
		limits.total = limits.background = limits.scope = 0;
		h.setNow(T0 + 16001);
		await h.timers.maintenance();
		expect(h.timers.notifications().items[0]?.status).toBe("pending");
		expect(h.timers.get(timerId)?.timer.state).toBe("active");
		limits.total = limits.background = limits.scope = 128;
		await h.timers.maintenance();
		await settle(h.queue);
		expect(h.timers.get(timerId)?.timer.state).toBe("elapsed");
	} finally {
		await h.close();
	}
});
