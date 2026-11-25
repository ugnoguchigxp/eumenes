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
import type { ChildExecution } from "../../tool-runtime";
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

const execution = (deadline: number) =>
	({
		id: "call-1",
		executionId: "exec-1",
		revision: 1,
		step: 0,
		chainRevisionId: "toolchain:image.create@1",
		request: "森の画像を作って",
		refs: [],
		source: {
			conversationId: "main",
			messageId: "m1",
			runId: "run-1",
			request: "森の画像を作って",
			digest: "d",
		},
		deadline,
		modelCalls: 6,
	}) as unknown as ChildExecution;

/** A fake LARM: each request takes the next scripted step, the last one repeating. */
function setup(script: Step[], options: { deadlineMs?: number } = {}) {
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
	const inference = {
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
		validateExecutionInTransaction: () => true,
	});
	queue.start();
	const deadline = BASE + (options.deadlineMs ?? 3 * 3600 * SECOND);
	const start = () =>
		store.write((db) =>
			image.startInTransaction(db, {
				runId: "run-1",
				conversationId: "main",
				question: "森の画像を作って",
				originalRequest: "森の画像を作って",
				deadline,
				execution: execution(deadline),
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
		deadline,
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
	// The row keeps its caller's deadline: the wait runs up to it, never past it.
	expect(h.store.read((db) => row(db, id)!.deadline)).toBe(h.deadline);
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

test("T3: a refusal that never ends retries every 30 s and stops at 30 minutes with larm_capacity_timeout", async () => {
	const h = setup(["busy"]);
	const { id } = await h.start();
	let count = 1;
	await until(waiting(h, id, count));
	while (h.image.get(id)?.state !== "failed" && count < 100) {
		h.advance(h.generateJob(id).availableAtMs);
		count++;
		const next = waiting(h, id, count);
		await until(() => h.image.get(id)?.state === "failed" || next());
	}
	expect(h.image.get(id)).toMatchObject({
		state: "failed",
		errorCode: LARM_CAPACITY_TIMEOUT,
	});
	// One request at the start and one per 30 s try, within 30 minutes.
	expect(h.requests).toHaveLength(61);
	expect(h.requests.at(-1)! - BASE).toBeLessThanOrEqual(30 * 60 * SECOND);
	const sent = h.requests.length;
	h.advance(BASE + 2 * 3600 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(sent);
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

test("T5: an execution keeps its caller's deadline and ends with larm_capacity_timeout", async () => {
	const h = setup(["busy", "ok"], { deadlineMs: 120 * SECOND });
	const { id } = await h.start();
	await until(() => h.image.get(id)?.state === "failed");
	expect(h.image.get(id)).toMatchObject({ errorCode: LARM_CAPACITY_TIMEOUT });
	expect(h.requests).toHaveLength(1);
	expect(h.store.read((db) => row(db, id)!.deadline)).toBe(h.deadline);
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
		await h.queue.close(100);
	});
