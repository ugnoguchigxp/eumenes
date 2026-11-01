import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createLocalServices } from "../../larm";
import { createExcalidraw, migrations, registerDrawingOperations } from "..";
import { registerExcalidraw } from "../controller";
import { drawingFixture } from "./connection.fixture";

const blank = { elements: [], appState: {}, files: {} };
const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const yieldTurn = () => new Promise((r) => setImmediate(r));
const flush = async () => {
	for (let i = 0; i < 20; i++) await yieldTurn();
};

/** LARM's single "no free memory" refusal, returned before the lease is accepted. */
const refusal = (retryAfter?: string) =>
	new Response(
		JSON.stringify({
			error: { code: "resource_exhausted", resource: "memory", message: "x" },
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				...(retryAfter ? { "Retry-After": retryAfter } : {}),
			},
		},
	);

async function setup(
	options: {
		onWaiting?: (db: Database, runId: string, untilMs: number) => number | null;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-drawing-wait-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	stores.push(store);
	const clock = { t: 1_700_000_000_000 };
	const f = drawingFixture();
	const leaseRequests: number[] = [];
	const refuse = { on: false, retryAfter: undefined as string | undefined };
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).endsWith("/leases") && (init?.method ?? "GET") === "POST") {
			leaseRequests.push(clock.t);
			if (refuse.on) return refusal(refuse.retryAfter);
		}
		return f.fetcher(url, init);
	}) as typeof fetch;
	const connection = () => ({
		...f.connection(),
		client: createLocalServices({
			baseUrl: "http://127.0.0.1:19810",
			token: "consumer-".repeat(5),
			fetch: fetcher,
		}),
	});
	const queue = createQueue(store, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
		random: () => 0,
		resources: { "excalidraw.connect": 1, "inference.llm": 1 },
	});
	const service = createExcalidraw({
		store,
		connection,
		webOrigin: "http://127.0.0.1:5173",
		fetch: fetcher,
		pollMs: 1,
		clock: () => clock.t,
	});
	const linked: string[] = [],
		finished: string[] = [],
		extended: number[] = [];
	const operations = registerDrawingOperations({
		store,
		queue,
		inference: {} as never,
		capabilities: { validateInTransaction() {} } as never,
		service,
		clock: () => clock.t,
		onJob: (_db, _runId, jobId) => linked.push(jobId),
		onFinished: (_db, runId) => finished.push(runId),
		onWaiting:
			options.onWaiting ??
			((_db, _runId, untilMs) => {
				extended.push(untilMs);
				return untilMs;
			}),
	});
	// A saved drawing the operation opens.
	const first = await service.session({
		requestId: crypto.randomUUID(),
		conversationId: "main",
	});
	await service.wait(first.id);
	const doc = await service.create(
		first.id,
		{ title: "図", scene: blank },
		crypto.randomUUID(),
		AbortSignal.timeout(1000),
	);
	await service.release(first.id);
	const referenceId = service.list("main")[0]!.id;
	void doc;
	leaseRequests.length = 0;
	f.requests.length = 0;
	async function start(
		input: { delegated?: boolean; deadlineMs?: number } = {},
	) {
		const id = crypto.randomUUID(),
			runId = `run-${id}`,
			deadline = clock.t + (input.deadlineMs ?? 300_000);
		await store.write((db) => {
			db.query("INSERT INTO excalidraw_operations VALUES(?,?,?,?,?,?,?,?)").run(
				id,
				runId,
				"main",
				JSON.stringify({
					id,
					runId,
					conversationId: "main",
					state: "starting",
					sessionId: null,
					referenceId,
					url: null,
					action: "open",
					errorCode: null,
					title: "図",
				}),
				JSON.stringify({
					action: "open",
					referenceId,
					revision: null,
					title: "図",
					...(input.delegated
						? { execution: { id, refs: [], erased: false } }
						: {}),
				}),
				"{}",
				deadline,
				null,
			);
			const { job } = queue.enqueueInTransaction(db, {
				scope: "excalidraw",
				kind: "excalidraw.open",
				dedupeKey: `${id}:open`,
				payload: { id },
				subjectRef: id,
				lane: "interactive",
				resourceKey: "excalidraw.connect",
				maxAttempts: 1,
				deadlineAtMs: deadline - 15000,
			});
			db.query("UPDATE excalidraw_operations SET job_id=? WHERE id=?").run(
				job.id,
				id,
			);
		});
		return { id, runId, deadline };
	}
	const record = (id: string) =>
		store.read((db) => {
			const r = db
				.query(
					"SELECT record_json,deadline,job_id FROM excalidraw_operations WHERE id=?",
				)
				.get(id) as { record_json: string; deadline: number; job_id: string };
			return {
				...JSON.parse(r.record_json),
				deadline: r.deadline,
				jobId: r.job_id,
			};
		});
	const job = (jobId: string) =>
		store.read(
			(db) =>
				db
					.query("SELECT state,available_at_ms FROM queue_jobs WHERE id=?")
					.get(jobId) as { state: string; available_at_ms: number },
		);
	async function run() {
		await queue.tick();
		await flush();
	}
	return {
		store,
		clock,
		f,
		refuse,
		leaseRequests,
		service,
		operations,
		queue,
		linked,
		finished,
		extended,
		start,
		record,
		job,
		run,
		referenceId,
		fetcher,
	};
}

test("T1/T10: a refused start waits as waiting_capacity, sends nothing until the planned time, then sends once and completes", async () => {
	const h = await setup();
	h.refuse.on = true;
	const { id, runId } = await h.start();
	const t0 = h.clock.t;
	await h.run();
	const waiting = h.record(id);
	expect(waiting.state).toBe("waiting_capacity");
	expect(waiting.capacityWait).toMatchObject({
		startedAt: t0,
		count: 1,
		at: t0 + 30_000,
		deadline: t0 + 30_000 + 180_000,
	});
	expect(h.leaseRequests).toHaveLength(1);
	// The run is kept open past the next try, and the new job replaces the one cancel would target.
	expect(h.extended).toEqual([t0 + 210_000]);
	expect(waiting.deadline).toBe(t0 + 210_000);
	expect(h.linked).toHaveLength(1);
	expect(waiting.jobId).toBe(h.linked[0]!);
	expect(h.job(waiting.jobId)).toEqual({
		state: "queued",
		available_at_ms: t0 + 30_000,
	});
	expect(h.finished).toEqual([]);
	// Nothing reaches LARM before the planned time.
	h.clock.t = t0 + 29_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(1);
	expect(h.record(id).state).toBe("waiting_capacity");
	h.refuse.on = false;
	h.clock.t = t0 + 30_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(2);
	const done = h.record(id);
	expect(done.state).toBe("completed");
	expect(done.url).toContain("#drawing/");
	expect(runId).toBe(done.runId);
});

test("T2: Retry-After longer than 30 s sets the next try", async () => {
	const h = await setup();
	h.refuse.on = true;
	h.refuse.retryAfter = "90";
	const { id } = await h.start();
	const t0 = h.clock.t;
	await h.run();
	expect(h.record(id).capacityWait.at).toBe(t0 + 90_000);
	h.clock.t = t0 + 60_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(1);
	h.clock.t = t0 + 90_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(2);
});

test("T3: a refusal that never ends stops at 30 minutes with larm_capacity_timeout, one request per try", async () => {
	const h = await setup();
	h.refuse.on = true;
	const { id } = await h.start();
	const t0 = h.clock.t;
	await h.run();
	for (let i = 0; i < 100 && h.record(id).state !== "failed"; i++) {
		h.clock.t = h.record(id).capacityWait.at;
		await h.run();
	}
	const failed = h.record(id);
	expect(failed.state).toBe("failed");
	expect(failed.errorCode).toBe("larm_capacity_timeout");
	expect(h.finished).toEqual([failed.runId]);
	expect(h.leaseRequests.at(-1)! - t0).toBeLessThanOrEqual(30 * 60_000);
	// 30 s apart, exactly one request each.
	expect(h.leaseRequests).toHaveLength(61);
	for (let i = 1; i < h.leaseRequests.length; i++)
		expect(h.leaseRequests[i]! - h.leaseRequests[i - 1]!).toBe(30_000);
	// Every try restarted the one session the operation opened (the other row is the setup's).
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM excalidraw_sessions").get() as {
						n: number;
					}
				).n,
		),
	).toBe(2);
	const count = h.leaseRequests.length;
	h.clock.t += 600_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(count);
});

test("T4: cancelling while waiting cancels the queued job and nothing is sent afterwards", async () => {
	const h = await setup();
	h.refuse.on = true;
	const { id } = await h.start();
	const t0 = h.clock.t;
	await h.run();
	const waiting = h.record(id);
	expect(waiting.state).toBe("waiting_capacity");
	await h.store.write((db) => h.operations.cancelCallInTransaction(db, id));
	expect(h.record(id).state).toBe("cancelled");
	expect(h.job(waiting.jobId).state).toBe("cancelled");
	h.refuse.on = false;
	h.clock.t = t0 + 60_000;
	await h.run();
	expect(h.leaseRequests).toHaveLength(1);
	expect(h.record(id).state).toBe("cancelled");
});

test("T5: a delegated task or a run whose deadline is fixed never extends its deadline and ends with larm_capacity_timeout", async () => {
	const delegated = await setup();
	delegated.refuse.on = true;
	const task = await delegated.start({ delegated: true, deadlineMs: 100_000 });
	await delegated.run();
	const failed = delegated.record(task.id);
	expect(failed.state).toBe("failed");
	expect(failed.errorCode).toBe("larm_capacity_timeout");
	expect(failed.deadline).toBe(task.deadline);
	expect(delegated.extended).toEqual([]);
	expect(delegated.leaseRequests).toHaveLength(1);

	// A conversation run whose caller fixed the deadline: the dialogue refuses to extend it.
	const fixed = await setup({ onWaiting: () => null });
	fixed.refuse.on = true;
	const op = await fixed.start();
	await fixed.run();
	expect(fixed.record(op.id).errorCode).toBe("larm_capacity_timeout");
	expect(fixed.record(op.id).deadline).toBe(op.deadline);
	expect(fixed.leaseRequests).toHaveLength(1);
	// A deadline below the next try cannot be extended either.
	const short = await setup({ onWaiting: (_db, _run, until) => until - 1 });
	short.refuse.on = true;
	const op2 = await short.start();
	await short.run();
	expect(short.record(op2.id).errorCode).toBe("larm_capacity_timeout");
});

test("T10: a refused session start fails once as larm_capacity_busy; ready() and activity never send it again, and the routes answer 503", async () => {
	const h = await setup();
	h.refuse.on = true;
	h.refuse.retryAfter = "90";
	const app = new Hono();
	registerExcalidraw(app, h.service);
	const s = await h.service.session({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		referenceId: h.referenceId,
	});
	const failed = (await h.service.wait(s.id))!;
	expect(failed).toMatchObject({
		state: "failed",
		errorCode: "larm_capacity_busy",
		retryAfterMs: 90_000,
	});
	expect(h.leaseRequests).toHaveLength(1);
	for (const [method, path] of [
		["POST", `/api/excalidraw/sessions/${s.id}/activity`],
		["GET", `/api/excalidraw/sessions/${s.id}/document`],
	] as const) {
		const response = await app.request(path, { method });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "larm_capacity_busy",
			retryAfterMs: 90_000,
		});
	}
	await expect(h.service.activity(s.id)).rejects.toThrow("larm_capacity_busy");
	expect(h.leaseRequests).toHaveLength(1);
	// Only a new start from the Web (a reconnect) sends the lease request again.
	h.refuse.on = false;
	await h.service.reconnect(s.id);
	const ready = (await h.service.wait(s.id))!;
	expect(ready).toMatchObject({ state: "ready", errorCode: null });
	expect(h.leaseRequests).toHaveLength(2);
});

test("T11: an idle session refused for memory repeats the refusal only inside the wait, then a save sends the lease request again", async () => {
	const h = await setup();
	const s = await h.service.session({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		referenceId: h.referenceId,
	});
	expect((await h.service.wait(s.id))?.state).toBe("ready");
	h.clock.t += 31_000;
	await h.service.tick();
	expect(h.service.get(s.id)?.state).toBe("idle");
	h.leaseRequests.length = 0;
	const t0 = h.clock.t;
	const update = { title: "図", scene: blank, expectedRevision: 1 };
	// A gesture finds LARM full: the lease request is refused once.
	h.refuse.on = true;
	await expect(h.service.activity(s.id)).rejects.toThrow("larm_capacity_busy");
	expect(h.leaseRequests).toEqual([t0]);
	// Inside the window nothing reaches LARM, however often it is asked.
	h.clock.t = t0 + 29_000;
	await expect(
		h.service.save(s.id, update, "k1", AbortSignal.timeout(1000)),
	).rejects.toThrow("larm_capacity_busy");
	await expect(h.service.activity(s.id)).rejects.toThrow("larm_capacity_busy");
	expect(h.leaseRequests).toHaveLength(1);
	// After the window the save really sends, is refused again while full, and opens a new window.
	h.clock.t = t0 + 30_000;
	await expect(
		h.service.save(s.id, update, "k1", AbortSignal.timeout(1000)),
	).rejects.toThrow("larm_capacity_busy");
	expect(h.leaseRequests).toEqual([t0, t0 + 30_000]);
	// Memory frees; the next save after that window succeeds.
	h.refuse.on = false;
	h.clock.t = t0 + 60_000;
	await h.service.tick();
	const saved = await h.service.save(
		s.id,
		update,
		"k1",
		AbortSignal.timeout(1000),
	);
	expect(saved.revision).toBe(2);
	expect(h.leaseRequests).toEqual([t0, t0 + 30_000, t0 + 60_000]);
});
