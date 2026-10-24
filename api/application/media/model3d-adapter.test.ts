import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../infrastructure/sqlite";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { migrations as imageMigrations } from "../../domains/image";
import {
	createModel3d,
	migrations as model3dMigrations,
	registerModel3d,
	type Model3dLarm,
} from "../../domains/model3d";
import {
	createModel3dAdapter,
	describeModel3dAdapter,
} from "./model3d-adapter";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
const saved = {
	id: "asset_1",
	title: "前のロボット",
	tags: ["ロボット"],
	createdAt: "2026-10-18T00:00:00.000Z",
	prompt: null,
	warnings: [],
	hasSource: false,
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-model3d-adapter-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...model3dMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	const larm = {
		assets: async () => ({ assets: [saved], total: 1, nextCursor: null }),
		asset: async () => {
			throw Object.assign(new Error("larm_http_404"), {
				status: 404,
				reason: null,
				retryAfterMs: null,
			});
		},
	} as unknown as Model3dLarm;
	const service = createModel3d({ store, queue, larm: () => larm });
	cleanup.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store, adapter: createModel3dAdapter(service) };
}
const conversation = {
	kind: "conversation" as const,
	owner: { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 },
	runId: "run-1",
	conversationId: "c1",
	messageId: "m1",
};

test("each operation takes the builtin schema its tool declares", () => {
	expect(
		Object.fromEntries(
			[...describeModel3dAdapter().operations].map(([k, v]) => [
				k,
				v.inputSchemaRef,
			]),
		),
	).toEqual({
		"model3d.open": "builtin:emptyInput",
		"model3d.generate": "builtin:model3dGenerate",
		"model3d.find": "builtin:model3dFind",
		"model3d.show": "builtin:model3dTarget",
		"model3d.update": "builtin:model3dUpdate",
		"model3d.delete": "builtin:model3dTarget",
		"model3d.cancel": "builtin:model3dJobTarget",
	});
});

test("the conversation may only name assets and images its snapshot showed", async () => {
	const { service, store, adapter } = setup();
	await service.assets("owner-unused", {}, new AbortController().signal);
	const invoke = (operationName: string, input: unknown) =>
		store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin: conversation,
			}),
		);
	// Assets seen under another owner are not this owner's targets.
	await expect(invoke("model3d.show", { assetRef: "asset_1" })).rejects.toThrow(
		"model3d_asset_not_found",
	);
	await expect(
		invoke("model3d.generate", {
			prompt: "",
			title: "画像から",
			tags: [],
			sourceImageRef: "img_unknown",
		}),
	).rejects.toThrow("model3d_image_not_found");
	const snapshot = store.read((db) => adapter.snapshotInTransaction(db)) as {
		assets: unknown[];
		images: unknown[];
	};
	expect(snapshot.assets).toEqual([]);
	expect(snapshot.images).toEqual([]);
});

test("a pipeline step may name an image its own conversation made; an image of another conversation still may not", async () => {
	const { store, adapter } = setup();
	await store.write((db) => {
		for (const [id, conversationId] of [
			["img_run", "c1"],
			["img_elsewhere", "c2"],
		] as const)
			db.query(
				"INSERT INTO image_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,'{}','[]',0)",
			).run(
				id,
				`run-${id}`,
				conversationId,
				JSON.stringify({
					id,
					state: "completed",
					artifactId: id,
					title: "猫",
					description: "",
					createdAt: 0,
					updatedAt: 0,
				}),
			);
	});
	const origin = {
		kind: "task" as const,
		owner: conversation.owner,
		runId: "run-1",
		conversationId: "c1",
		messageId: "m1",
		execution: { deadline: Date.now() + 60_000 } as never,
	};
	const generate = (sourceImageRef: string) =>
		store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName: "model3d.generate",
				input: { prompt: "", title: "画像から", tags: [], sourceImageRef },
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin,
			}),
		);
	expect((await generate("img_run")).receiptRef.owner).toBe("model3d");
	await expect(generate("img_elsewhere")).rejects.toThrow(
		"model3d_image_not_found",
	);
});

test("HTTP: the request is validated, and a missing asset is a 404 that leaves the index", async () => {
	const { service, store } = setup();
	const app = new Hono();
	registerModel3d(app, service, "owner");
	const bad = await app.request("/api/model3d/generations", {
		method: "POST",
		body: JSON.stringify({
			requestId: "x",
			title: "",
			tags: [],
			source: { type: "url" },
		}),
	});
	expect(bad.status).toBe(400);
	await service.assets("owner", {}, new AbortController().signal);
	expect(
		store.read((db) => service.snapshotInTransaction(db, "owner")).assets,
	).toHaveLength(1);
	const missing = await app.request("/api/model3d/assets/asset_1");
	expect(missing.status).toBe(404);
	expect(
		store.read((db) => service.snapshotInTransaction(db, "owner")).assets,
	).toHaveLength(0);
});
