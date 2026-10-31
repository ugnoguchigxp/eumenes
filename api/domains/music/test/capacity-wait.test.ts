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
import { migrations, record, row } from "../repository";
import { createMusic } from "../service";

const BASE = Date.parse("2026-11-01T00:00:00Z");
const SECOND = 1000;
const prepared = {
	package: {
		kind: "package",
		id: "music.create",
		revision: 3,
		profileRevisionId: "profile:music.fake@1",
		requiredSkillRevisionIds: ["skill:music.fake@1"],
	},
	dependencies: [
		{ revisionId: "profile:music.fake@1", kind: "profile", body: "担当" },
		{ revisionId: "skill:music.fake@1", kind: "skill", body: "手順" },
	],
} as unknown as Prepared;
const plan = {
	task: "music",
	title: "雨の本",
	description: "静かな雨",
	prompt: "soft piano, rain",
	durationSeconds: 45,
	instrumental: true,
};
const target = (capability: string, protocol = "fake.v1") =>
	({
		id: capability,
		model: "fake-model",
		capability,
		protocol,
		mode: "service",
		description: "fake service",
	}) as unknown as LarmTestTarget;
const targets = [
	target("media.music.generate"),
	target("media.image.generate", "larm.image-generation.v1"),
];

type Step = "busy" | { busy: number } | "ok" | Error;
const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	setSystemTime();
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const idle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake LARM: each request takes the next scripted step, the last one repeating. */
function setup(
	script: Step[],
	options: { onWaiting?: (until: number) => number | null } = {},
) {
	setSystemTime(new Date(BASE));
	const dir = mkdtempSync(join(tmpdir(), "eumenes-music-wait-"));
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
		musicProviders: async () => [],
		catalog: async () => ({ targets }),
		execute: async (t: LarmTestTarget) => {
			requests.push(Date.now());
			const step = script[Math.min(requests.length, script.length) - 1]!;
			if (step === "busy") throw new LarmCapacityBusy(null);
			if (step instanceof Error) throw step;
			if (typeof step === "object") throw new LarmCapacityBusy(step.busy);
			return t.capability === "media.image.generate"
				? { bytes: new Uint8Array([7, 7]), mime: "image/png" }
				: { bytes: new Uint8Array([1, 2, 3, 4]), mime: "audio/mpeg" };
		},
		images: { remove: async () => ({ deleted: true }) },
	} as unknown as LarmPlayground;
	const music = createMusic({
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
		validateExecutionInTransaction: () => true,
	});
	queue.start();
	const start = (execution?: ChildExecution) =>
		store.write((db) =>
			music.startInTransaction(db, {
				runId: "run-1",
				conversationId: "main",
				question: "雨の曲を作って",
				originalRequest: "雨の曲を作って",
				deadline: BASE + 120 * SECOND,
				execution,
			}),
		);
	const job = (id: string) =>
		queue.get(store.read((db) => row(db, id)!.queue_job_id!))!;
	const advance = (to: number) => setSystemTime(new Date(to));
	return {
		store,
		queue,
		music,
		requests,
		jobs,
		finished,
		extended,
		start,
		job,
		advance,
	};
}
type Harness = ReturnType<typeof setup>;
const waiting = (h: Harness, id: string, count: number) => () =>
	h.music.get(id)?.capacityWait?.count === count &&
	h.job(id).state === "queued";

test("T1/T10: a capacity refusal waits 30 s, sends the request once more, and completes", async () => {
	const h = setup(["busy", "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	expect(h.music.get(id)).toMatchObject({
		state: "generating",
		phase: LARM_CAPACITY_WAITING,
		capacityWait: { startedAt: BASE, count: 1 },
	});
	const job = h.job(id);
	expect(job).toMatchObject({
		kind: "music.generate",
		dedupeKey: `${id}:generate:w1`,
		availableAtMs: BASE + 30 * SECOND,
		maxAttempts: 1,
		state: "queued",
	});
	expect(h.jobs.at(-1)).toBe(job.id);
	expect(h.extended).toEqual([["run-1", BASE + 330 * SECOND]]);
	expect(h.store.read((db) => row(db, id)!.deadline)).toBe(BASE + 330 * SECOND);
	expect(h.finished).toEqual([]);
	h.advance(BASE + 29 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	h.advance(BASE + 30 * SECOND);
	await until(() => h.music.get(id)?.state === "completed");
	expect(h.requests).toEqual([BASE, BASE + 30 * SECOND]);
	expect(h.music.get(id)).toMatchObject({ phase: "completed" });
	expect(h.finished).toEqual(["run-1"]);
	await h.queue.close(100);
});

test("T2: Retry-After 90 schedules the next try 90 s later", async () => {
	const h = setup([{ busy: 90 * SECOND }, "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	expect(h.job(id).availableAtMs).toBe(BASE + 90 * SECOND);
	h.advance(BASE + 89 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	h.advance(BASE + 90 * SECOND);
	await until(() => h.music.get(id)?.state === "completed");
	expect(h.requests).toHaveLength(2);
	await h.queue.close(100);
});

test("T3: refusals stop after 30 minutes with larm_capacity_timeout and nothing is sent afterwards", async () => {
	const h = setup(["busy"]);
	const { id } = await h.start();
	let count = 1;
	await until(waiting(h, id, count));
	for (;;) {
		h.advance(h.job(id).availableAtMs);
		await until(
			() =>
				h.music.get(id)?.state === "failed" ||
				(h.music.get(id)?.capacityWait?.count === count + 1 &&
					h.job(id).state === "queued"),
			{ timeout: 5000 },
		);
		if (h.music.get(id)?.state === "failed") break;
		count++;
	}
	expect(h.requests).toHaveLength(61);
	expect(h.music.get(id)).toMatchObject({
		state: "failed",
		errorCode: LARM_CAPACITY_TIMEOUT,
	});
	expect(h.finished).toEqual(["run-1"]);
	h.advance(BASE + 2 * 3600 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(61);
	expect(
		h.queue.list({ kind: "music.generate", state: "queued" }).items,
	).toHaveLength(0);
	await h.queue.close(100);
}, 30_000);

test("T4: cancelling during the wait cancels the waiting job and nothing is sent", async () => {
	const h = setup(["busy", "ok"]);
	const { id } = await h.start();
	await until(waiting(h, id, 1));
	await h.queue.cancel(h.job(id).id);
	expect(h.music.get(id)).toMatchObject({
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
	await until(() => h.music.get(id)?.state === "failed");
	expect(h.music.get(id)).toMatchObject({ errorCode: LARM_CAPACITY_TIMEOUT });
	expect(h.requests).toHaveLength(1);
	expect(h.finished).toEqual(["run-1"]);
	await h.queue.close(100);
});

test("T5: a child execution keeps its caller's deadline and ends with larm_capacity_timeout", async () => {
	const h = setup(["busy", "ok"]);
	const child = {
		id: "child",
		executionId: "exec-1",
		revision: 1,
		step: 0,
		chainRevisionId: "toolchain:music.create@1",
		request: "雨の曲を作って",
		refs: [],
		source: {
			conversationId: "main",
			messageId: "m1",
			runId: "run-d",
			request: "雨の曲を作って",
			digest: "d",
		},
		deadline: BASE + 120 * SECOND,
		modelCalls: 6,
	} as unknown as ChildExecution;
	const { id } = await h.start(child);
	await until(() => h.music.get(id)?.state === "failed");
	expect(h.music.get(id)).toMatchObject({ errorCode: LARM_CAPACITY_TIMEOUT });
	expect(h.requests).toHaveLength(1);
	expect(h.extended).toEqual([]);
	expect(h.store.read((db) => row(db, id)!.deadline)).toBe(BASE + 120 * SECOND);
	expect(h.finished).toEqual([]);
	await h.queue.close(100);
});

for (const [name, failure, code] of [
	["a non-capacity 503", new Error("larm_http_503"), "larm_http_503"],
	["a network error", new TypeError("fetch failed"), "music_generation_failed"],
	["generation_unknown", new Error("generation_unknown"), "generation_unknown"],
] as const)
	test(`T6: ${name} fails once with no resend`, async () => {
		const h = setup([failure, "ok"]);
		const { id } = await h.start();
		await until(() => h.music.get(id)?.state === "failed");
		expect(h.music.get(id)).toMatchObject({ errorCode: code });
		expect(h.music.get(id)?.capacityWait).toBeUndefined();
		h.advance(BASE + 10 * 60 * SECOND);
		await idle();
		expect(h.requests).toHaveLength(1);
		expect(h.extended).toEqual([]);
		await h.queue.close(100);
	});

/** The cover image request is not tied to a run: it waits on its own queue job. */
async function artworkSetup(script: Step[]) {
	const h = setup(script);
	await h.store.write((db) =>
		db
			.query(
				`INSERT INTO music_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline)
				VALUES('track','run-0','main',?,'{}','{}',0)`,
			)
			.run(
				JSON.stringify({
					id: "track",
					state: "completed",
					title: "Track",
					prompt: "Instrumental",
					description: "",
				}),
			),
	);
	await h.music.requestArtwork("track");
	const artwork = () => h.store.read((db) => record(row(db, "track")!).artwork);
	const job = () =>
		h.queue.get(h.queue.list({ kind: "music.artwork" }).items[0]!.id)!;
	const waits = (count: number) => () =>
		artwork()?.capacityWait?.count === count && job().state === "queued";
	return { h, artwork, job, waits };
}

test("T1/T2/T10: the cover image waits for LARM, then sends once more and completes", async () => {
	const { h, artwork, job, waits } = await artworkSetup([
		{ busy: 90 * SECOND },
		"ok",
	]);
	await until(waits(1));
	expect(artwork()).toMatchObject({
		state: "generating",
		phase: LARM_CAPACITY_WAITING,
		capacityWait: { startedAt: BASE, count: 1 },
	});
	expect(job()).toMatchObject({
		dedupeKey: "track:artwork:1:w1",
		availableAtMs: BASE + 90 * SECOND,
		deadlineAtMs: BASE + 390 * SECOND,
		maxAttempts: 1,
	});
	h.advance(BASE + 89 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	h.advance(BASE + 90 * SECOND);
	await until(() => artwork()?.state === "completed");
	expect(h.requests).toEqual([BASE, BASE + 90 * SECOND]);
	expect(artwork()).toEqual({
		state: "completed",
		revision: 1,
		errorCode: null,
	});
	expect(h.music.artwork("track")).toEqual({
		bytes: new Uint8Array([7, 7]),
		mime: "image/png",
	});
	await h.queue.close(100);
});

test("T3: the cover image stops after 30 minutes with larm_capacity_timeout", async () => {
	const { h, artwork, job, waits } = await artworkSetup(["busy"]);
	let count = 1;
	await until(waits(count));
	for (;;) {
		h.advance(job().availableAtMs);
		await until(() => artwork()?.state === "failed" || waits(count + 1)(), {
			timeout: 5000,
		});
		if (artwork()?.state === "failed") break;
		count++;
	}
	expect(h.requests).toHaveLength(61);
	expect(artwork()).toEqual({
		state: "failed",
		revision: 1,
		errorCode: LARM_CAPACITY_TIMEOUT,
	});
	h.advance(BASE + 2 * 3600 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(61);
	await h.queue.close(100);
}, 30_000);

test("T4: cancelling the cover image during the wait sends nothing more", async () => {
	const { h, artwork, job, waits } = await artworkSetup(["busy", "ok"]);
	await until(waits(1));
	await h.queue.cancel(job().id);
	expect(artwork()).toEqual({
		state: "failed",
		revision: 1,
		errorCode: "cancel_requested",
	});
	h.advance(BASE + 10 * 60 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	await h.queue.close(100);
});

test("T6: a cover image failure other than a capacity refusal is not sent again", async () => {
	const { h, artwork } = await artworkSetup([new Error("larm_http_503"), "ok"]);
	await until(() => artwork()?.state === "failed");
	expect(artwork()).toMatchObject({ errorCode: "larm_http_503" });
	h.advance(BASE + 10 * 60 * SECOND);
	await idle();
	expect(h.requests).toHaveLength(1);
	await h.queue.close(100);
});
