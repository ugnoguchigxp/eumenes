import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor as until } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { LarmCapacityBusy } from "../../larm";
import { createModel3d, migrations } from "..";
import type {
	Model3dCompletion,
	Model3dLarm,
	Model3dSharedImages,
} from "../contracts";

type Job = Awaited<ReturnType<Model3dLarm["job"]>>;
class Refusal extends Error {
	constructor(
		readonly status: number,
		readonly reason: string | null = null,
		readonly retryAfterMs: number | null = null,
	) {
		super(`larm_http_${status}`);
	}
}
const asset = (id: string, title = "青緑のロボット") => ({
	id,
	title,
	tags: ["ロボット"],
	createdAt: "2026-10-18T00:00:00.000Z",
	prompt: "白い背景に、青緑の小さなロボットを全身で描く",
	warnings: [],
	hasSource: true,
});

/** An in-memory LARM 3D API whose answers each test scripts. */
function fakeLarm() {
	const calls: Array<{ op: string; args: unknown[] }> = [];
	const state = {
		catalog: {
			mesh: { model: "mesh-model-a", path: "/v1/3d/generations" },
			image: { model: "image-model-b", path: "/v1/images/generations" },
		} as Awaited<ReturnType<Model3dLarm["discover"]>>,
		submits: [] as Array<() => string | Promise<string>>,
		jobs: [] as Array<Job | (() => Job)>,
		assets: new Map([["asset-old", asset("asset-old", "前のロボット")]]),
	};
	const larm: Model3dLarm = {
		async discover() {
			calls.push({ op: "discover", args: [] });
			return state.catalog;
		},
		async submit(path, body, key) {
			calls.push({ op: "submit", args: [path, body, key] });
			const next = state.submits.shift();
			if (!next) return "job-1";
			return next();
		},
		async job(path, jobId) {
			calls.push({ op: "job", args: [path, jobId] });
			const next = state.jobs.length > 1 ? state.jobs.shift()! : state.jobs[0]!;
			return typeof next === "function" ? next() : next;
		},
		async cancel(path, jobId) {
			calls.push({ op: "cancel", args: [path, jobId] });
		},
		async assets() {
			return {
				assets: [...state.assets.values()],
				total: state.assets.size,
				nextCursor: null,
			};
		},
		async asset(id) {
			const a = state.assets.get(id);
			if (!a) throw new Refusal(404);
			return a;
		},
		async update(id, patch) {
			calls.push({ op: "update", args: [id, patch] });
			const a = { ...state.assets.get(id)!, ...patch };
			state.assets.set(id, a);
			return a;
		},
		async remove(id) {
			calls.push({ op: "remove", args: [id] });
			if (!state.assets.delete(id)) throw new Refusal(404);
		},
		async content() {
			return {
				bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
				mime: "model/gltf-binary",
			};
		},
	};
	return { larm, calls, state };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function boot(
	dir: string,
	fake: ReturnType<typeof fakeLarm>,
	options: { followMs?: number; sharedImages?: Model3dSharedImages } = {},
) {
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const notices: Model3dCompletion[] = [];
	const service = createModel3d({
		store,
		queue,
		larm: () => fake.larm,
		announceInTransaction: (_db, n) => notices.push(n),
		pollMs: 5,
		...options,
	});
	queue.start();
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await queue.close(100);
		await store.close();
	};
	cleanup.push(stop);
	return { service, store, notices, stop };
}
function setup(
	options: { followMs?: number; sharedImages?: Model3dSharedImages } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-model3d-"));
	const fake = fakeLarm();
	const booted = boot(dir, fake, options);
	cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
	return { dir, ...booted, ...fake };
}
const prompt = {
	type: "prompt" as const,
	prompt: "白い背景に、青緑の小さなロボットを全身で描く",
};
const state = (service: ReturnType<typeof setup>["service"], id: string) =>
	service.get("owner", id);

test("a prompt is sent with the catalog's models, and a lost response sends the same key and body once more", async () => {
	const { service, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new TypeError("fetch failed");
	});
	larm.jobs.push(
		{ status: "running", stage: "image" },
		{ status: "running", stage: "mesh" },
		{
			status: "completed",
			stage: "completed",
			assetId: "asset-new",
			warnings: ["暗いテクスチャ"],
		},
	);
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "青緑のロボット",
		tags: ["ロボット"],
		source: prompt,
	});
	expect(g.state).toBe("submitting");
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(2);
	expect(submits[0]!.args).toEqual(submits[1]!.args);
	const [path, body, key] = submits[0]!.args as [
		string,
		Record<string, unknown>,
		string,
	];
	expect(path).toBe("/v1/3d/generations");
	expect(key).toMatch(/^[0-9a-f-]{36}$/);
	expect(body).toMatchObject({
		model: "mesh-model-a",
		source: {
			type: "prompt",
			prompt: prompt.prompt,
			imageModel: "image-model-b",
		},
		resolution: 512,
	});
	expect(body).not.toHaveProperty("steps");
	expect(calls.filter((c) => c.op === "discover")).toHaveLength(1);
	const done = state(service, g.id);
	expect(done).toMatchObject({
		assetId: "asset-new",
		deleted: false,
		warnings: ["暗いテクスチャ"],
		stageLabel: "生成完了",
	});
	// Screen requests are shown on the screen only.
	expect(state(service, g.id).origin).toBe("screen");
});

test("an existing LARM image is sent without imageModel", async () => {
	const { service, calls, state: larm } = setup();
	larm.jobs.push({ status: "completed", assetId: "asset-new" });
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "画像から",
		tags: [],
		source: { type: "image-artifact", id: "img-1" },
	});
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	const body = calls.find((c) => c.op === "submit")!.args[1];
	expect(body).toMatchObject({
		source: { type: "image-artifact", id: "img-1" },
	});
	expect(JSON.stringify(body)).not.toContain("imageModel");
});

/** Shared images the way the application keeps them: held per generation, saved once into the library. */
function fakeShared(files: string[]) {
	const calls: string[] = [];
	let gate: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		gate = resolve;
	});
	const shared: Model3dSharedImages = {
		hold(id, key) {
			if (!files.includes(id)) throw new Error("model3d_image_not_found");
			calls.push(`hold:${id}:${key}`);
		},
		async artifact(id, key) {
			calls.push(`artifact:${id}:${key}`);
			await opened;
			if (id.endsWith("bad")) throw new Error("model3d_source_import_failed");
			return `lib-${id.slice(0, 4)}`;
		},
		release(key) {
			calls.push(`release:${key}`);
		},
	};
	return { shared, calls, open: () => gate() };
}
const sharedId = "5b0c6f1e-0000-4000-8000-000000000001";

test("an attached image is saved to the library first, then sent as that library image", async () => {
	const files = fakeShared([sharedId]);
	const { service, calls, state: larm } = setup({ sharedImages: files.shared });
	larm.jobs.push({ status: "completed", assetId: "asset-new" });
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "添付から",
		tags: [],
		source: { type: "shared-image", id: sharedId },
	});
	expect(files.calls).toEqual([`hold:${sharedId}:${g.id}`]);
	await until(() => state(service, g.id).stageLabel === "元画像を保存中", {
		timeout: 3000,
	});
	expect(calls.some((c) => c.op === "submit")).toBe(false);
	files.open();
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	expect(calls.find((c) => c.op === "submit")!.args[1]).toMatchObject({
		source: { type: "image-artifact", id: "lib-5b0c" },
	});
	expect(files.calls).toEqual([
		`hold:${sharedId}:${g.id}`,
		`artifact:${sharedId}:${g.id}`,
		`release:${g.id}`,
	]);
	expect(state(service, g.id).source).toEqual({
		type: "shared-image",
		id: sharedId,
	});
});

test("a shared image that is gone refuses the generation; one LARM cannot save fails it unsent", async () => {
	const bad = "5b0c6f1e-0000-4000-8000-000000000bad";
	const files = fakeShared([bad]);
	const { service, calls } = setup({ sharedImages: files.shared });
	await expect(
		service.create("owner", "main", {
			requestId: crypto.randomUUID(),
			title: "消えた画像",
			tags: [],
			source: { type: "shared-image", id: sharedId },
		}),
	).rejects.toThrow("model3d_image_not_found");
	files.open();
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "保存できない画像",
		tags: [],
		source: { type: "shared-image", id: bad },
	});
	await until(() => state(service, g.id).state === "failed", { timeout: 3000 });
	expect(state(service, g.id).errorCode).toBe("model3d_source_import_failed");
	expect(calls.some((c) => c.op === "submit")).toBe(false);
	expect(files.calls.at(-1)).toBe(`release:${g.id}`);
});

test("without the 3D service nothing is sent and the model is never guessed", async () => {
	const { service, calls, state: larm } = setup();
	larm.catalog = { mesh: null, image: larm.catalog.image };
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "failed", { timeout: 3000 });
	expect(state(service, g.id).errorCode).toBe("model3d_service_unavailable");
	expect(calls.some((c) => c.op === "submit")).toBe(false);
});

test("429, 503 and 409 fail once with a model3d code and nothing is sent again", async () => {
	const expected = {
		429: "model3d_busy",
		503: "model3d_unavailable",
		409: "model3d_idempotency_conflict",
	} as const;
	for (const status of [429, 503, 409] as const) {
		const { service, calls, state: larm } = setup();
		larm.submits.push(() => {
			throw new Refusal(status, null, 20);
		});
		const g = await service.create("owner", "main", {
			requestId: crypto.randomUUID(),
			title: "ロボット",
			tags: [],
			source: prompt,
		});
		await until(() => state(service, g.id).state === "failed", {
			timeout: 3000,
		});
		await Bun.sleep(60);
		expect(state(service, g.id).errorCode).toBe(expected[status]);
		expect(calls.filter((c) => c.op === "submit")).toHaveLength(1);
	}
});

test("a failure that is not a lost response is sent once; the queue never runs it again", async () => {
	const { service, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new Error("boom");
	});
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "failed", { timeout: 3000 });
	await Bun.sleep(60);
	expect(state(service, g.id).errorCode).toBe("model3d_submission_unconfirmed");
	expect(calls.filter((c) => c.op === "submit")).toHaveLength(1);
});

test("interrupted and worker_stop_failed end the generation and nothing is resubmitted", async () => {
	for (const reason of ["interrupted", "worker_stop_failed"]) {
		const { service, calls, state: larm } = setup();
		larm.jobs.push({ status: "failed", stage: "failed", errorCode: reason });
		const g = await service.create("owner", "main", {
			requestId: crypto.randomUUID(),
			title: "ロボット",
			tags: [],
			source: prompt,
		});
		await until(() => state(service, g.id).state === "failed", {
			timeout: 3000,
		});
		expect(state(service, g.id).errorCode).toBe(`model3d_${reason}`);
		expect(calls.filter((c) => c.op === "submit")).toHaveLength(1);
	}
});

test("a deleted completion is shown as deleted without an asset", async () => {
	const { service, state: larm } = setup();
	larm.jobs.push({ status: "completed", stage: "deleted", deleted: true });
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	expect(state(service, g.id)).toMatchObject({
		deleted: true,
		assetId: null,
		stageLabel: "完成品は削除済み",
	});
});

test("cancelling sends DELETE for the job and a later completion is not adopted", async () => {
	const { service, calls, state: larm } = setup();
	larm.jobs.push({ status: "running", stage: "mesh" });
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "running", {
		timeout: 3000,
	});
	larm.jobs.splice(0, larm.jobs.length, {
		status: "completed",
		assetId: "asset-late",
	});
	await service.cancel("owner", g.id);
	await until(() => calls.some((c) => c.op === "cancel"), { timeout: 3000 });
	await Bun.sleep(50);
	expect(state(service, g.id)).toMatchObject({
		state: "cancelled",
		assetId: null,
	});
});

test("an unconfirmed submission is rechecked with the same key and body", async () => {
	const { service, calls, state: larm } = setup();
	// The first send and its one resend are both lost.
	for (let i = 0; i < 2; i++)
		larm.submits.push(() => {
			throw new TypeError("fetch failed");
		});
	larm.jobs.push({ status: "completed", assetId: "asset-new" });
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "failed", { timeout: 3000 });
	expect(state(service, g.id).errorCode).toBe("model3d_submission_unconfirmed");
	await service.recheck("owner", g.id);
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(3);
	expect(new Set(submits.map((c) => JSON.stringify(c.args))).size).toBe(1);
});

test("the same screen request is idempotent and a different body conflicts", async () => {
	const { service } = setup();
	const requestId = crypto.randomUUID();
	const input = { requestId, title: "ロボット", tags: [], source: prompt };
	const a = await service.create("owner", "main", input);
	const b = await service.create("owner", "main", input);
	expect(b.id).toBe(a.id);
	await expect(
		service.create("owner", "main", { ...input, title: "別のロボット" }),
	).rejects.toThrow("request_conflict");
});

test("conversation commands: generate reports completion, find/show focus, delete forgets", async () => {
	const { service, store, notices, calls, state: larm } = setup();
	await service.assets("owner", {}, new AbortController().signal);
	larm.jobs.push({
		status: "completed",
		assetId: "asset-new",
		warnings: ["面が粗い"],
	});
	larm.assets.set("asset-new", asset("asset-new"));
	const run = (
		op: Parameters<typeof service.commandInTransaction>[3],
		input: object,
		requestId = crypto.randomUUID(),
	) =>
		store.write((db) =>
			service.commandInTransaction(db, "owner", "c1", op, input, requestId),
		);
	const generated = (
		await run("generate", {
			prompt: prompt.prompt,
			title: "青緑のロボット",
			tags: ["ロボット"],
		})
	).value as { generation: { generationRef: string } };
	const id = generated.generation.generationRef;
	await until(() => state(service, id).state === "completed", {
		timeout: 3000,
	});
	await until(() => notices.length === 1, { timeout: 1000 });
	expect(notices[0]).toMatchObject({ conversationId: "c1" });
	expect(notices[0]!.message).toContain("できました");
	expect(notices[0]!.message).toContain("面が粗い");

	const found = (await run("find", { query: "前の", tags: [] })).value as {
		matches: Array<{ assetRef: string }>;
	};
	expect(found.matches.map((m) => m.assetRef)).toEqual(["asset-old"]);
	const requestId = crypto.randomUUID();
	await run("show", { assetRef: "asset-old" }, requestId);
	const replay = await run("show", { assetRef: "asset-old" }, requestId);
	expect(replay.replay).toBe(true);
	await expect(
		run("show", { assetRef: "asset-new" }, requestId),
	).rejects.toThrow("request_conflict");
	const source = store.read((db) => service.sourceInTransaction(db, "owner"));
	expect(source.data.focus).toMatchObject({
		kind: "asset",
		assetId: "asset-old",
	});

	await run("delete", { assetRef: "asset-old" });
	await until(() => calls.some((c) => c.op === "remove"), { timeout: 3000 });
	await until(
		() =>
			!store
				.read((db) => service.snapshotInTransaction(db, "owner"))
				.assets.some((a) => a.assetRef === "asset-old"),
		{ timeout: 3000 },
	);
	await expect(run("show", { assetRef: "asset-old" })).rejects.toThrow(
		"model3d_asset_not_found",
	);
});

test("a busy LARM while following waits instead of failing the generation", async () => {
	const { service, state: larm } = setup();
	larm.jobs.push(
		() => {
			throw new Refusal(503);
		},
		() => {
			throw new Error("network_unavailable");
		},
		{ status: "completed", assetId: "asset-new" },
	);
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	expect(state(service, g.id).errorCode).toBeNull();
});

test("a recheck after a timeout reports the completion it finds", async () => {
	const { service, store, notices, state: larm } = setup({ followMs: 50 });
	larm.jobs.push({ status: "running", stage: "mesh" });
	const { value } = await store.write((db) =>
		service.commandInTransaction(
			db,
			"owner",
			"c1",
			"generate",
			{ prompt: prompt.prompt, title: "ロボット", tags: [] },
			crypto.randomUUID(),
		),
	);
	const id = (value as { generation: { generationRef: string } }).generation
		.generationRef;
	await until(() => state(service, id).errorCode === "model3d_timeout", {
		timeout: 3000,
	});
	larm.jobs.splice(0, larm.jobs.length, {
		status: "completed",
		assetId: "asset-new",
	});
	larm.assets.set("asset-new", asset("asset-new"));
	await service.recheck("owner", id);
	await until(() => state(service, id).state === "completed", {
		timeout: 3000,
	});
	await until(() => notices.length === 2, { timeout: 1000 });
	expect(notices[0]!.message).toContain("作れませんでした");
	expect(notices[1]!.message).toContain("できました");
	expect(notices[0]!.id).not.toBe(notices[1]!.id);
});

test("cancelling an unconfirmed submission resends it to learn the job, then cancels that job", async () => {
	const { service, calls, state: larm } = setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	larm.submits.push(async () => {
		await gate;
		throw new Error("boom");
	});
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => calls.some((c) => c.op === "submit"), { timeout: 3000 });
	await service.cancel("owner", g.id);
	release();
	await until(() => calls.some((c) => c.op === "cancel"), { timeout: 3000 });
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(2);
	expect(submits[0]!.args).toEqual(submits[1]!.args);
	expect(calls.find((c) => c.op === "cancel")!.args[1]).toBe("job-1");
	expect(state(service, g.id).state).toBe("cancelled");
});

test("removing an asset LARM no longer has counts as removed", async () => {
	const { service, store } = setup();
	await service.assets("owner", {}, new AbortController().signal);
	await service.remove("owner", "asset-old", new AbortController().signal);
	await service.remove("owner", "asset-old", new AbortController().signal);
	expect(
		store.read((db) => service.snapshotInTransaction(db, "owner")).assets,
	).toEqual([]);
});

const submitJob = (store: ReturnType<typeof setup>["store"]) =>
	store.read(
		(db) =>
			db
				.query(
					"SELECT id, state, available_at_ms AS at, payload_json AS payload FROM queue_jobs WHERE kind='model3d.submit' ORDER BY created_seq DESC LIMIT 1",
				)
				.get() as { id: string; state: string; at: number; payload: string },
	);
/** Lets the wait pass: the scheduled send becomes due now. */
const dueNow = (
	store: ReturnType<typeof setup>["store"],
	edit?: (payload: Record<string, unknown>) => void,
) =>
	store.write((db) => {
		const job = db
			.query(
				"SELECT id, payload_json AS payload FROM queue_jobs WHERE kind='model3d.submit' AND state IN ('queued','retry_wait') LIMIT 1",
			)
			.get() as { id: string; payload: string };
		const payload = JSON.parse(job.payload);
		edit?.(payload);
		db.query(
			"UPDATE queue_jobs SET available_at_ms=?, payload_json=? WHERE id=?",
		).run(Date.now(), JSON.stringify(payload), job.id);
	});
const create = (service: ReturnType<typeof setup>["service"]) =>
	service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
const waiting = (service: ReturnType<typeof setup>["service"], id: string) =>
	state(service, id).stage === "waiting_capacity";

test("a capacity refusal waits 30 s, sends the same key once and then follows the job", async () => {
	const { service, store, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new LarmCapacityBusy(null);
	});
	larm.jobs.push({ status: "completed", assetId: "asset-new" });
	larm.assets.set("asset-new", asset("asset-new"));
	const before = Date.now();
	const g = await create(service);
	await until(() => waiting(service, g.id), { timeout: 3000 });
	expect(state(service, g.id)).toMatchObject({
		state: "submitting",
		stageLabel: "LARMの空きを待っています。ほかの処理が終わりしだい始めます。",
	});
	const job = submitJob(store);
	expect(job.state).toBe("queued");
	expect(job.at - before).toBeGreaterThanOrEqual(30_000);
	expect(job.at - Date.now()).toBeLessThanOrEqual(30_000);
	expect(JSON.parse(job.payload).capacity).toMatchObject({ count: 1 });
	// No request leaves before the scheduled time, from the queue or anywhere else.
	await Bun.sleep(100);
	expect(calls.filter((c) => c.op === "submit")).toHaveLength(1);

	dueNow(store);
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(2);
	expect(submits[0]!.args).toEqual(submits[1]!.args);
	expect(state(service, g.id).errorCode).toBeNull();
});

test("a lost response followed by a capacity refusal on the second send is a wait, then succeeds with the same key", async () => {
	const { service, store, calls, state: larm } = setup();
	larm.submits.push(
		() => {
			throw new TypeError("fetch failed");
		},
		() => {
			throw new LarmCapacityBusy(null);
		},
	);
	larm.jobs.push({ status: "completed", assetId: "asset-new" });
	larm.assets.set("asset-new", asset("asset-new"));
	const g = await create(service);
	await until(() => waiting(service, g.id), { timeout: 3000 });
	expect(state(service, g.id).state).toBe("submitting");
	expect(calls.filter((c) => c.op === "submit")).toHaveLength(2);

	dueNow(store);
	await until(() => state(service, g.id).state === "completed", {
		timeout: 3000,
	});
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(3);
	expect(submits[2]!.args).toEqual(submits[0]!.args);
	expect(state(service, g.id).errorCode).toBeNull();
});

test("Retry-After 90 s moves the next send to 90 s", async () => {
	const { service, store, state: larm } = setup();
	larm.submits.push(() => {
		throw new LarmCapacityBusy(90_000);
	});
	const g = await create(service);
	await until(() => waiting(service, g.id), { timeout: 3000 });
	const wait = submitJob(store).at - Date.now();
	expect(wait).toBeGreaterThan(88_000);
	expect(wait).toBeLessThanOrEqual(90_000);
});

test("a capacity wait that would pass 30 minutes ends with larm_capacity_timeout and sends nothing more", async () => {
	const { service, store, calls, notices, state: larm } = setup();
	for (let i = 0; i < 3; i++)
		larm.submits.push(() => {
			throw new LarmCapacityBusy(null);
		});
	const { value } = await store.write((db) =>
		service.commandInTransaction(
			db,
			"owner",
			"c1",
			"generate",
			{ prompt: prompt.prompt, title: "ロボット", tags: [] },
			crypto.randomUUID(),
		),
	);
	const id = (value as { generation: { generationRef: string } }).generation
		.generationRef;
	await until(() => waiting(service, id), { timeout: 3000 });
	// The first refusal was 31 minutes ago.
	dueNow(store, (payload) => {
		(payload.capacity as { startedAt: number }).startedAt =
			Date.now() - 31 * 60_000;
	});
	await until(() => state(service, id).state === "failed", { timeout: 3000 });
	await Bun.sleep(60);
	expect(state(service, id)).toMatchObject({
		errorCode: "larm_capacity_timeout",
		errorLabel:
			"LARMの空きを待ちましたが、待てる時間内に空かなかったため中止しました。",
		stage: null,
	});
	expect(calls.filter((c) => c.op === "submit")).toHaveLength(2);
	await until(() => notices.length === 1, { timeout: 1000 });
	expect(notices[0]!.message).toContain("作れませんでした");
});

test("a task's fixed deadline is not extended by the wait", async () => {
	const { service, store, state: larm } = setup();
	larm.submits.push(() => {
		throw new LarmCapacityBusy(null);
	});
	const { value } = await store.write((db) =>
		service.commandInTransaction(
			db,
			"owner",
			"c1",
			"generate",
			{ prompt: prompt.prompt, title: "ロボット", tags: [] },
			crypto.randomUUID(),
			{ deadline: Date.now() + 10_000 },
		),
	);
	const id = (value as { generation: { generationRef: string } }).generation
		.generationRef;
	await until(() => state(service, id).state === "failed", { timeout: 3000 });
	expect(state(service, id).errorCode).toBe("larm_capacity_timeout");
});

test("cancelling during the wait cancels it and nothing is sent afterwards", async () => {
	const { service, store, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new LarmCapacityBusy(null);
	});
	const g = await create(service);
	await until(() => waiting(service, g.id), { timeout: 3000 });
	const waitingJob = submitJob(store);
	await service.cancel("owner", g.id);
	expect(state(service, g.id)).toMatchObject({
		state: "cancelled",
		errorCode: null,
	});
	await Bun.sleep(100);
	expect(
		store.read(
			(db) =>
				(
					db
						.query("SELECT state FROM queue_jobs WHERE id=?")
						.get(waitingJob.id) as { state: string }
				).state,
		),
	).toBe("cancelled");
	expect(calls.filter((c) => c.op === "submit")).toHaveLength(1);
	expect(calls.some((c) => c.op === "cancel")).toBe(false);
});

test("cancelling while the scheduled send is in flight learns the job with the same key and cancels it", async () => {
	const { service, store, calls, state: larm } = setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	larm.submits.push(
		() => {
			throw new LarmCapacityBusy(null);
		},
		async () => {
			await gate;
			return "job-1";
		},
	);
	const g = await create(service);
	await until(() => waiting(service, g.id), { timeout: 3000 });
	dueNow(store);
	await until(() => calls.filter((c) => c.op === "submit").length === 2, {
		timeout: 3000,
	});
	// The send has started, so the screen no longer says it waits for memory.
	expect(state(service, g.id).stage).not.toBe("waiting_capacity");
	await service.cancel("owner", g.id);
	release();
	await until(() => calls.some((c) => c.op === "cancel"), { timeout: 3000 });
	const submits = calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(3);
	expect(submits[1]!.args).toEqual(submits[2]!.args);
	expect(calls.find((c) => c.op === "cancel")!.args[1]).toBe("job-1");
	expect(state(service, g.id).state).toBe("cancelled");
});

test("a restart during the wait resumes the send when it is due", async () => {
	const first = setup();
	first.state.submits.push(() => {
		throw new LarmCapacityBusy(null);
	});
	first.state.jobs.push({ status: "completed", assetId: "asset-new" });
	first.state.assets.set("asset-new", asset("asset-new"));
	const g = await create(first.service);
	await until(() => waiting(first.service, g.id), { timeout: 3000 });
	await first.stop();

	const second = boot(first.dir, first);
	expect(state(second.service, g.id)).toMatchObject({
		state: "submitting",
		stage: "waiting_capacity",
	});
	await Bun.sleep(100);
	expect(first.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	dueNow(second.store);
	await until(() => state(second.service, g.id).state === "completed", {
		timeout: 3000,
	});
	const submits = first.calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(2);
	expect(submits[0]!.args).toEqual(submits[1]!.args);
});

test("a send interrupted by a restart is recovered with one more send of the same key and never again", async () => {
	const first = setup();
	first.state.submits.push(() => new Promise<string>(() => {}));
	const g = await create(first.service);
	await until(() => first.calls.some((c) => c.op === "submit"), {
		timeout: 3000,
	});
	await first.stop();

	// The recovery send is lost again: it is not repeated.
	first.state.submits.push(() => {
		throw new Error("boom");
	});
	const second = boot(first.dir, first);
	await until(() => state(second.service, g.id).state === "failed", {
		timeout: 5000,
	});
	await Bun.sleep(100);
	expect(state(second.service, g.id).errorCode).toBe(
		"model3d_submission_unconfirmed",
	);
	const submits = first.calls.filter((c) => c.op === "submit");
	expect(submits).toHaveLength(2);
	expect(submits[0]!.args).toEqual(submits[1]!.args);
});
