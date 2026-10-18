import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor as until } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createModel3d, migrations } from "..";
import type { Model3dCompletion, Model3dLarm } from "../contracts";

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
		async source() {
			return { bytes: new Uint8Array([1]), mime: "image/png" };
		},
	};
	return { larm, calls, state };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup(options: { followMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-model3d-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const fake = fakeLarm();
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
	cleanup.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store, notices, ...fake };
}
const prompt = {
	type: "prompt" as const,
	prompt: "白い背景に、青緑の小さなロボットを全身で描く",
};
const state = (service: ReturnType<typeof setup>["service"], id: string) =>
	service.get("owner", id);

test("a prompt is sent with the catalog's models, and the same key and body on a resend", async () => {
	const { service, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new Error("network_unavailable");
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

test("429 waits and resends the same key; 409 ends without a new key", async () => {
	const { service, calls, state: larm } = setup();
	larm.submits.push(() => {
		throw new Refusal(429, null, 20);
	});
	larm.submits.push(() => {
		throw new Refusal(409, "idempotency_conflict");
	});
	const g = await service.create("owner", "main", {
		requestId: crypto.randomUUID(),
		title: "ロボット",
		tags: [],
		source: prompt,
	});
	await until(() => state(service, g.id).state === "failed", { timeout: 3000 });
	expect(state(service, g.id).errorCode).toBe("model3d_idempotency_conflict");
	const keys = calls.filter((c) => c.op === "submit").map((c) => c.args[2]);
	expect(keys).toHaveLength(2);
	expect(new Set(keys).size).toBe(1);
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
	// The queue tries a submission three times.
	for (let i = 0; i < 3; i++)
		larm.submits.push(() => {
			throw new Error("network_unavailable");
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
		throw new Error("network_unavailable");
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
