import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { waitFor as until } from "../../../infrastructure/wait-for";
import type { Capabilities, Prepared } from "../../capabilities";
import type { InferencePort } from "../../inference";
import {
	LARM_CAPACITY_TIMEOUT,
	LARM_CAPACITY_WAITING,
	LarmCapacityBusy,
	type LarmPlayground,
	type LarmTestTarget,
} from "../../larm";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations } from "..";
import { createImage } from "../service";
import { row } from "../repository";

const BASE = Date.parse("2026-11-01T00:00:00Z");
const SECOND = 1000;
const prepared = {
	package: {
		kind: "package",
		id: "image.create",
		revision: 1,
		profileRevisionId: "profile:image.fake@1",
		requiredSkillRevisionIds: ["skill:image.fake@1"],
		toolRevisionIds: ["tool:image.fake@1"],
	},
	dependencies: [
		{ revisionId: "profile:image.fake@1", kind: "profile", body: "担当" },
		{ revisionId: "skill:image.fake@1", kind: "skill", body: "手順" },
		{
			revisionId: "tool:image.fake@1",
			kind: "tool",
			title: "生成",
			summary: "画像を生成する",
		},
	],
} as unknown as Prepared;
const plan = {
	action: "generate",
	title: "森",
	description: "",
	prompt: "a forest",
	width: 256,
	height: 256,
	format: "png",
	seed: 1,
};
const target = {
	id: "t1",
	model: "fake-model",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	mode: "service",
	description: "画像を生成する",
} as unknown as LarmTestTarget;
const artifact = { id: "img-1", path: "/a", mime: "image/png" };

type Step = "busy" | { busy: number } | "ok" | Error;
const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	setSystemTime();
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake LARM: each request takes the next scripted step, the last one repeating. */
function setup(
	script: Step[],
	options: { onWaiting?: (until: number) => number | null } = {},
) {
	setSystemTime(new Date(BASE));
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-wait-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	stores.push(store);
	const queue = createQueue(store, { pollMs: 5 });
	const requests: number[] = [];
	const jobs: string[] = [];
	const finished: string[] = [];
	const extended: Array<[string, number]> = [];
	const inference = {
		captureControlInTransaction: () => "request-1",
		captureUserControlInTransaction: () => "request-1",
		executeControl: async () => ({
			requestId: "request-1",
			attemptId: "attempt-1",
			value: JSON.stringify(plan),
		}),
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	const capabilities = {
		prepareActiveByIdInTransaction: () => prepared,
		validateInTransaction: () => {},
	} as unknown as Capabilities;
	const gateway = {
		catalog: async () => ({ targets: [target] }),
		execute: async () => {
			requests.push(Date.now());
			const step = script[Math.min(requests.length, script.length) - 1]!;
			if (step === "busy") throw new LarmCapacityBusy(null);
			if (step instanceof Error) throw step;
			if (typeof step === "object") throw new LarmCapacityBusy(step.busy);
			return { bytes: new Uint8Array([1, 2, 3]), mime: "image/png", artifact };
		},
	} as unknown as LarmPlayground;
	const image = createImage({
		store,
		queue,
		inference,
		capabilities,
		gateway: () => gateway,
		onJob: (_db, _runId, jobId) => jobs.push(jobId),
		onFinished: (_db, runId) => finished.push(runId),
		onWaiting: (_db, runId, untilMs) => {
			extended.push([runId, untilMs]);
			return options.onWaiting ? options.onWaiting(untilMs) : untilMs;
		},
	});
	queue.start();
	const start = () =>
		store.write((db) =>
			image.startInTransaction(db, {
				runId: "run-1",
				conversationId: "main",
				question: "森の画像を作って",
				originalRequest: "森の画像を作って",
				deadline: BASE + 120 * SECOND,
			}),
		);
	const generateJob = (id: string) => {
		const jobId = store.read((db) => row(db, id)!.queue_job_id!);
		return queue.get(jobId)!;
	};
	/** Moves the clock and lets the queue's poll run. */
	const advance = (to: number) => setSystemTime(new Date(to));
	return {
		store,
		queue,
		image,
		requests,
		jobs,
		finished,
		extended,
		start,
		generateJob,
		advance,
	};
}
type Harness = ReturnType<typeof setup>;
const waiting = (h: Harness, id: string, count: number) => () =>
	h.image.get(id)?.capacityWait?.count === count &&
	h.generateJob(id).state === "queued";
const idle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test("T1/T10: a capacity refusal waits 30 s, sends the request once more, and completes", async () => {
	const h = setup(["busy", "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	const first = h.image.get(id)!;
	expect(first).toMatchObject({
		state: "generating",
		phase: LARM_CAPACITY_WAITING,
		capacityWait: { startedAt: BASE, count: 1 },
	});
	const job = h.generateJob(id);
	expect(job).toMatchObject({
		kind: "image.generate",
		dedupeKey: `${id}:generate:w1`,
		availableAtMs: BASE + 30 * SECOND,
		maxAttempts: 1,
		state: "queued",
	});
	// The run follows the waiting job, and its deadline covers the next try's whole budget.
	expect(h.jobs.at(-1)).toBe(job.id);
	expect(h.extended).toEqual([["run-1", BASE + 330 * SECOND]]);
	expect(h.store.read((db) => row(db, id)!.deadline)).toBe(BASE + 330 * SECOND);
	expect(h.finished).toEqual([]);
	// Nothing is sent before the scheduled time.
	h.advance(BASE + 29 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	h.advance(BASE + 30 * SECOND);
	await until(() => h.image.get(id)?.state === "completed");
	expect(h.requests).toEqual([BASE, BASE + 30 * SECOND]);
	expect(h.image.get(id)).toMatchObject({
		state: "completed",
		phase: "completed",
		artifactId: "img-1",
	});
	expect(h.finished).toEqual(["run-1"]);
	await h.queue.close(100);
});

test("T2: Retry-After 90 schedules the next try 90 s later", async () => {
	const h = setup([{ busy: 90 * SECOND }, "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	expect(h.generateJob(id).availableAtMs).toBe(BASE + 90 * SECOND);
	h.advance(BASE + 89 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	h.advance(BASE + 90 * SECOND);
	await until(() => h.image.get(id)?.state === "completed");
	expect(h.requests).toHaveLength(2);
	await h.queue.close(100);
});

test("T3: refusals stop after 30 minutes with larm_capacity_timeout and nothing is sent afterwards", async () => {
	const h = setup(["busy"]);
	const { id } = await h.start();
	let count = 1;
	await until(waiting(h, id, count));
	for (;;) {
		h.advance(h.generateJob(id).availableAtMs);
		await until(
			() =>
				h.image.get(id)?.state === "failed" ||
				(h.image.get(id)?.capacityWait?.count === count + 1 &&
					h.generateJob(id).state === "queued"),
			{ timeout: 5000 },
		);
		if (h.image.get(id)?.state === "failed") break;
		count++;
	}
	// One first send plus a try every 30 s up to the 30-minute limit.
	expect(h.requests).toHaveLength(61);
	expect(h.requests.at(-1)).toBe(BASE + 30 * 60 * SECOND);
	expect(h.image.get(id)).toMatchObject({
		state: "failed",
		errorCode: LARM_CAPACITY_TIMEOUT,
	});
	expect(h.finished).toEqual(["run-1"]);
	h.advance(BASE + 2 * 3600 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(61);
	expect(
		h.queue.list({ kind: "image.generate", state: "queued" }).items,
	).toHaveLength(0);
	await h.queue.close(100);
}, 30_000);

test("T4: cancelling during the wait cancels the waiting job and nothing is sent", async () => {
	const h = setup(["busy", "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	await h.queue.cancel(h.generateJob(id).id);
	expect(h.image.get(id)).toMatchObject({
		state: "cancelled",
		errorCode: "cancel_requested",
	});
	h.advance(BASE + 10 * 60 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	await h.queue.close(100);
});

test("T5: a run whose deadline cannot be extended ends with larm_capacity_timeout", async () => {
	const h = setup(["busy", "ok"], { onWaiting: () => null });
	const { id } = await h.start();
	await until(() => h.image.get(id)?.state === "failed");
	expect(h.image.get(id)).toMatchObject({ errorCode: LARM_CAPACITY_TIMEOUT });
	expect(h.requests).toHaveLength(1);
	expect(h.finished).toEqual(["run-1"]);
	await h.queue.close(100);
});

test("T5: a child execution keeps its caller's deadline and ends with larm_capacity_timeout", async () => {
	const h = setup(["busy", "ok"]);
	const record = {
		id: "child",
		runId: "run-1",
		conversationId: "main",
		state: "generating",
		title: "画像",
		description: "",
		prompt: plan.prompt,
		action: "generate",
		width: 256,
		height: 256,
		format: "png",
		seed: 1,
		artifactId: null,
		phase: "queued",
		errorCode: null,
		mime: null,
		actualModel: null,
		createdAt: BASE,
		updatedAt: BASE,
	};
	await h.store.write((db) => {
		db.query(
			"INSERT INTO image_generations(id,run_id,conversation_id,record_json,request_json,plan_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,'{}',?)",
		).run(
			"child",
			"run-1",
			"main",
			JSON.stringify(record),
			JSON.stringify({ execution: { id: "child" } }),
			JSON.stringify(plan),
			BASE + 120 * SECOND,
		);
		h.queue.enqueueInTransaction(db, {
			scope: "image",
			kind: "image.generate",
			dedupeKey: "child:generate",
			payload: { id: "child" },
			subjectRef: "child",
			lane: "interactive",
			resourceKey: "image.generate",
			maxAttempts: 1,
			deadlineAtMs: BASE + 105 * SECOND,
		});
	});
	h.queue.wake();
	await until(() => h.image.get("child")?.state === "failed");
	expect(h.image.get("child")).toMatchObject({
		errorCode: LARM_CAPACITY_TIMEOUT,
	});
	expect(h.requests).toHaveLength(1);
	expect(h.extended).toEqual([]);
	expect(h.store.read((db) => row(db, "child")!.deadline)).toBe(
		BASE + 120 * SECOND,
	);
	// A child execution is not a conversation run: nothing is reported to the run.
	expect(h.finished).toEqual([]);
	await h.queue.close(100);
});

for (const [name, failure, code] of [
	["a non-capacity 503", new Error("larm_http_503"), "larm_http_503"],
	[
		"image_model_unavailable",
		new Error("image_model_unavailable"),
		"image_model_unavailable",
	],
	["a network error", new TypeError("fetch failed"), "image_generation_failed"],
	["generation_unknown", new Error("generation_unknown"), "generation_unknown"],
] as const)
	test(`T6: ${name} fails once with no resend`, async () => {
		const h = setup([failure, "ok"]);
		const { id } = await h.start();
		await until(() => h.image.get(id)?.state === "failed");
		expect(h.image.get(id)).toMatchObject({ errorCode: code });
		expect(h.image.get(id)?.capacityWait).toBeUndefined();
		h.advance(BASE + 10 * 60 * SECOND);
		await idle();
		expect(h.requests).toHaveLength(1);
		expect(h.extended).toEqual([]);
		expect(h.finished).toEqual(["run-1"]);
		await h.queue.close(100);
	});
