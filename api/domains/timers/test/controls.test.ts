import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openTimers, startBody } from "./timers.test";
import { migrations } from "..";
import { digest } from "../service/canonical";
import { createTimers, timerReceiptSchema } from "..";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../../scheduler";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { waitFor } from "../../../infrastructure/wait-for";
import { migration } from "../repository/migrations";
import { TIMER_POLICY } from "../service/policy";

const T0 = Date.parse("2026-10-09T00:00:00Z");
const input = (revision: number, now: number) => ({
	requestId: crypto.randomUUID(),
	issuedAt: new Date(now).toISOString(),
	expectedRevision: revision,
});

test("pause freezes milliseconds past the original due time, resumes the same ID and fences old jobs", async () => {
	const h = await openTimers();
	try {
		const start = await h.timers.start(startBody(10));
		if (start.receipt.action !== "started")
			throw new Error("fixture_start_failed");
		const id = start.receipt.timer.id;
		h.setNow(T0 + 1250);
		const command = input(0, T0 + 1250);
		const pause = await h.timers.pause(id, command);
		if (pause.receipt.action === "listed")
			throw new Error("fixture_control_failed");
		expect(pause.receipt.action).toBe("paused");
		expect(pause.receipt.timer.remainingSeconds).toBe(9);
		expect((await h.timers.pause(id, command)).replay).toBe(true);
		h.setNow(T0 + 30000);
		await h.timers.recover();
		await h.scheduler.tick();
		expect(h.timers.get(id)?.timer.state).toBe("paused");
		expect(h.timers.get(id)?.timer.remainingSeconds).toBe(9);
		expect(h.timers.notifications().items).toHaveLength(0);
		const resumeCommand = input(1, T0 + 30000);
		const resume = await h.timers.resume(id, resumeCommand);
		expect((await h.timers.resume(id, resumeCommand)).replay).toBe(true);
		if (resume.receipt.action === "listed")
			throw new Error("fixture_control_failed");
		expect(resume.receipt.action).toBe("resumed");
		expect(resume.receipt.timer.id).toBe(id);
		expect(resume.receipt.timer.startedAt).toBe(start.receipt.timer.startedAt);
		expect(resume.receipt.timer.dueAt).toBe(new Date(T0 + 38750).toISOString());
		const stale = await h.store.write((tx) =>
			h.timers.handler.prepareInTransaction(tx, {
				payload: { timerId: id, cancelEpoch: 0, dispatchGeneration: 1 },
			} as never),
		);
		expect(stale.status).toBe("stale");
		h.setNow(T0 + 38000);
		expect(h.timers.get(id)?.timer.remainingSeconds).toBe(1);
		h.setNow(T0 + 38750);
		await h.scheduler.tick();
		await h.queue.tick();
		await waitFor(() => h.timers.get(id)?.timer.state === "elapsed");
		expect(h.timers.get(id)?.timer.state).toBe("elapsed");
		expect(h.timers.notifications().items).toHaveLength(1);
	} finally {
		await h.close();
	}
});

test("pause/resume validate revisions, scope, limits and rollback a rejected new schedule", async () => {
	const h = await openTimers();
	try {
		const saved = await h.timers.start(startBody(10));
		if (saved.receipt.action !== "started")
			throw new Error("fixture_start_failed");
		const id = saved.receipt.timer.id;
		const ownedElsewhere = await h.timers.start(startBody(10), {
			scope: "other",
		});
		if (ownedElsewhere.receipt.action !== "started")
			throw new Error("fixture_start_failed");
		await expect(
			h.timers.pause(ownedElsewhere.receipt.timer.id, input(0, T0)),
		).rejects.toThrow("timer_not_found");
		await expect(
			h.timers.resume(ownedElsewhere.receipt.timer.id, input(0, T0)),
		).rejects.toThrow("timer_not_found");
		await expect(h.timers.pause(id, input(8, T0))).rejects.toThrow(
			"revision_conflict",
		);
		await expect(
			h.timers.pause(crypto.randomUUID(), input(0, T0)),
		).rejects.toThrow("timer_not_found");
		await h.timers.pause(id, input(0, T0));
		const original = h.scheduler.createInTransaction;
		h.scheduler.createInTransaction = () => {
			throw new Error("scheduler_full");
		};
		await expect(h.timers.resume(id, input(1, T0))).rejects.toThrow(
			"scheduler_full",
		);
		h.scheduler.createInTransaction = original;
		expect(h.timers.get(id)?.timer.state).toBe("paused");
		expect(h.timers.get(id)?.timer.revision).toBe(1);
		const canceled = await h.timers.cancel(id, input(1, T0));
		if (canceled.receipt.action === "listed")
			throw new Error("fixture_control_failed");
		expect(canceled.receipt.timer.state).toBe("cancelled");
		await h.timers.resume(id, input(2, T0));
		expect(h.timers.get(id)?.timer.state).toBe("active");
	} finally {
		await h.close();
	}
});

test("the schema upgrade preserves notifications, original receipt digests and foreign keys", () => {
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys=ON");
		db.exec(migration);
		db.exec(migrations[1]!.sql);
		const id = crypto.randomUUID(),
			operationId = crypto.randomUUID();
		db.query(
			"INSERT INTO timers(id,scope,label,duration_seconds,started_at_ms,due_at_ms,state,created_at_ms,updated_at_ms) VALUES(?, 'default', 'タイマー', 10, ?, ?, 'active', ?, ?)",
		).run(id, T0, T0 + 10000, T0, T0);
		db.query(
			"INSERT INTO timer_notifications(id,timer_id,scope,generation,due_at_ms,status,created_at_ms,updated_at_ms) VALUES(?,?,'default',0,?,'pending',?,?)",
		).run(crypto.randomUUID(), id, T0 + 10000, T0, T0);
		// A receipt written before pausedAt existed must parse without changing its digest.
		const receipt = {
				kind: "timer_action",
				action: "started",
				operationId,
				serverNow: new Date(T0).toISOString(),
				artifact: { kind: "timer", version: 1, timerId: id },
				timer: {
					id,
					revision: 0,
					state: "active",
					label: "タイマー",
					durationSeconds: 10,
					startedAt: new Date(T0).toISOString(),
					dueAt: new Date(T0 + 10000).toISOString(),
					cancelledAt: null,
					remainingSeconds: 10,
					conversationId: null,
					originRunId: null,
					originMessageId: null,
					errorCode: null,
					bodyExpired: false,
				},
			},
			receiptDigest = digest(receipt);
		db.query(
			"INSERT INTO timer_operations(id,scope,request_id,issued_at_ms,input_digest,operation,timer_id,receipt_json,receipt_digest,created_at_ms) VALUES(?, 'default', ?, ?, 'input', 'start', ?, ?, ?, ?)",
		).run(
			operationId,
			crypto.randomUUID(),
			T0,
			id,
			JSON.stringify(receipt),
			receiptDigest,
			T0,
		);
		db.exec("BEGIN");
		db.exec(migrations[2]!.sql);
		db.exec("COMMIT");
		expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
		expect(digest(timerReceiptSchema.parse(receipt))).toBe(receiptDigest);
		expect(
			(
				db.query("SELECT COUNT(*) AS n FROM timer_notifications").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		expect(
			(
				db
					.query("SELECT receipt_digest FROM timer_operations WHERE id=?")
					.get(operationId) as { receipt_digest: string }
			).receipt_digest,
		).toBe(receiptDigest);
		expect(
			(
				db.query("SELECT paused_total_ms FROM timers WHERE id=?").get(id) as {
					paused_total_ms: number;
				}
			).paused_total_ms,
		).toBe(0);
	} finally {
		db.close();
	}
});

test("paused clocks survive reopening the store, repeated pauses and terminal retention", async () => {
	const h = await openTimers();
	const saved = await h.timers.start(startBody(10));
	if (saved.receipt.action !== "started")
		throw new Error("fixture_start_failed");
	const id = saved.receipt.timer.id;
	h.setNow(T0 + 1250);
	await h.timers.pause(id, input(0, T0 + 1250));
	await h.queue.close();
	await h.scheduler.close();
	await h.store.close();
	let now = T0 + TIMER_POLICY.retentionMs + 1000;
	const store = openStore(join(h.dir, "db.sqlite3"), [
		queueMigration,
		schedulerMigration,
		...migrations.map((m) => m.sql),
	]);
	const queue = createQueue(store, { now: () => now });
	const scheduler = createScheduler(store, queue, { now: () => now });
	const timers = createTimers(store, { queue, scheduler }, { now: () => now });
	try {
		await timers.recover();
		expect(timers.get(id)?.timer).toMatchObject({
			state: "paused",
			remainingSeconds: 9,
			bodyExpired: false,
		});
		const resumed = await timers.resume(id, input(1, now));
		if (resumed.receipt.action === "listed")
			throw new Error("fixture_control_failed");
		expect(resumed.receipt.timer.dueAt).toBe(
			new Date(now + 8750).toISOString(),
		);
		now += 1750;
		await timers.pause(id, input(2, now));
		expect(timers.get(id)?.timer.remainingSeconds).toBe(7);
		now += 2000;
		await timers.resume(id, input(3, now));
		expect(timers.get(id)?.timer.dueAt).toBe(
			new Date(now + 7000).toISOString(),
		);
		expect(timers.get(id)?.timer.startedAt).toBe(saved.receipt.timer.startedAt);
	} finally {
		await queue.close();
		await scheduler.close();
		await store.close();
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("paused clocks count toward capacity and old cancelled clocks resume only with time left", async () => {
	const h = await openTimers();
	try {
		const saved = await h.timers.start(startBody(10));
		if (saved.receipt.action !== "started")
			throw new Error("fixture_start_failed");
		const id = saved.receipt.timer.id;
		h.setNow(T0 + 1250);
		await h.timers.cancel(id, input(0, T0 + 1250));
		h.setNow(T0 + 30000);
		await h.timers.resume(id, input(1, T0 + 30000));
		expect(h.timers.get(id)?.timer.dueAt).toBe(
			new Date(T0 + 38750).toISOString(),
		);
		await h.timers.pause(id, input(2, T0 + 30000));
		for (let i = 1; i < TIMER_POLICY.maxActive; i++) {
			const next = await h.timers.start({
				...startBody(10),
				issuedAt: new Date(T0 + 30000).toISOString(),
			});
			if (next.receipt.action !== "started")
				throw new Error("fixture_start_failed");
			await h.timers.pause(next.receipt.timer.id, input(0, T0 + 30000));
		}
		await expect(
			h.timers.start({
				...startBody(10),
				issuedAt: new Date(T0 + 30000).toISOString(),
			}),
		).rejects.toThrow("timer_limit_reached");
		await h.timers.cancel(id, input(3, T0 + 30000));
		const extra = await h.timers.start({
			...startBody(1),
			issuedAt: new Date(T0 + 30000).toISOString(),
		});
		if (extra.receipt.action !== "started")
			throw new Error("fixture_start_failed");
		await expect(h.timers.resume(id, input(4, T0 + 30000))).rejects.toThrow(
			"timer_limit_reached",
		);
		h.setNow(T0 + 31000);
		await h.timers.pause(extra.receipt.timer.id, input(0, T0 + 31000));
		expect(h.timers.get(extra.receipt.timer.id)?.timer.state).toBe("active");
		await h.timers.cancel(extra.receipt.timer.id, input(0, T0 + 31000));
		await expect(
			h.timers.resume(extra.receipt.timer.id, input(1, T0 + 31000)),
		).rejects.toThrow("timer_not_resumable");
	} finally {
		await h.close();
	}
});
