import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities, Prepared } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { LarmPlayground, LarmTestTarget } from "../../larm";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations, registerImage } from "..";
import { createImage, imageListInTransaction } from "../service";

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
const target: LarmTestTarget = {
	id: "t1",
	name: "image",
	model: "fake-model",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	kind: "image",
	mode: "service",
	endpoint: "http://fake",
	profile: "fake",
	revision: "1",
	onDemand: false,
	primary: true,
	description: "画像を生成する",
};

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(cond: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}

type Options = {
	planValue?: string;
	targets?: LarmTestTarget[];
	output?: { bytes?: Uint8Array; mime?: string; artifactId?: string };
	validate?: () => void;
	accept?: boolean;
	images?: Partial<LarmPlayground["images"]>;
};
function setup(options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	stores.push(store);
	const queue = createQueue(store);
	const executed: unknown[] = [];
	const jobs: Array<[string, string]> = [];
	const finished: string[] = [];
	const inference = {
		captureControlInTransaction: () => "request-1",
		executeControl: async () => ({
			requestId: "request-1",
			attemptId: "attempt-1",
			value: options.planValue ?? JSON.stringify(plan),
		}),
		acceptInTransaction: () => options.accept ?? true,
	} as unknown as InferencePort;
	const capabilities = {
		prepareActiveByIdInTransaction: () => prepared,
		validateInTransaction: () => options.validate?.(),
	} as unknown as Capabilities;
	const gateway = {
		catalog: async () => ({ targets: options.targets ?? [target] }),
		execute: async (_t: unknown, input: unknown, _s: unknown, p: any) => {
			executed.push(input);
			await p({
				phase: "generating",
				artifact: {
					id: options.output?.artifactId ?? "img-1",
					path: "/a",
					mime: "image/png",
				},
			});
			return {
				bytes: options.output?.bytes ?? new Uint8Array([1, 2, 3]),
				mime: options.output?.mime ?? "image/png",
				artifact: {
					id: options.output?.artifactId ?? "img-1",
					path: "/a",
					mime: "image/png",
				},
			};
		},
		images: {
			list: async () => ({ images: [] }),
			remove: async (id: string) => ({ id, deleted: true }),
			get: async (id: string) => ({
				id,
				contentUrl: `/c/${id}`,
				mimeType: "image/png",
				model: "fake-model",
			}),
			...options.images,
		},
		artifact: async (a: { mime: string }) => ({
			bytes: new Uint8Array([9, 9]),
			mime: a.mime,
		}),
	} as unknown as LarmPlayground;
	const image = createImage({
		store,
		queue,
		inference,
		capabilities,
		gateway: () => gateway,
		onJob: (_db, runId, jobId) => jobs.push([runId, jobId]),
		onFinished: (_db, runId) => finished.push(runId),
	});
	queue.start();
	const start = (runId = "run-1", conversationId = "main") =>
		store.write((db) =>
			image.startInTransaction(db, {
				runId,
				conversationId,
				question: "森の画像を作って",
				originalRequest: "森の画像を作って",
				deadline: Date.now() + 120_000,
			}),
		);
	return { store, queue, image, executed, jobs, finished, start };
}
const settled = (h: ReturnType<typeof setup>, id: string) => () => {
	const state = h.image.get(id)?.state;
	return state !== "planning" && state !== "generating";
};

test("a request becomes a planning record with one plan job and is idempotent per run", async () => {
	const h = setup();
	const first = await h.start();
	const again = await h.start();
	expect(again).toEqual(first);
	expect(h.jobs).toHaveLength(1);
	expect(h.jobs[0]![0]).toBe("run-1");
	const record = h.image.get(first.id)!;
	expect(record.state).toBe("planning");
	expect(record.prompt).toBeNull();
	await h.queue.close(100);
});

test("plan then generate completes the record with the artifact and notifies once", async () => {
	const h = setup();
	const { id } = await h.start();
	await until(settled(h, id));
	const record = h.image.get(id)!;
	expect(record).toMatchObject({
		state: "completed",
		phase: "completed",
		prompt: "a forest",
		artifactId: "img-1",
		mime: "image/png",
		actualModel: "fake-model",
	});
	expect(h.executed).toEqual([
		{ text: "a forest", width: 256, height: 256, format: "png", seed: 1 },
	]);
	expect(h.finished).toEqual(["run-1"]);
	expect(
		h.store.read((db) => h.image.resultInTransaction(db, "run-1")),
	).toEqual(record);
	expect(
		h.store.read((db) => h.image.resultInTransaction(db, "other")),
	).toBeNull();
	await h.queue.close(100);
});

test("a studio plan completes without calling the generation service", async () => {
	const h = setup({
		planValue: JSON.stringify({ ...plan, action: "studio", prompt: "" }),
	});
	const { id } = await h.start();
	await until(settled(h, id));
	expect(h.image.get(id)).toMatchObject({
		state: "completed",
		action: "studio",
	});
	expect(h.executed).toEqual([]);
	expect(h.finished).toEqual(["run-1"]);
	await h.queue.close(100);
});

test("an invalid plan fails the record with a stable code", async () => {
	for (const [planValue, code] of [
		["not json", "image_plan_invalid_json"],
		[JSON.stringify({ ...plan, width: 99 }), "image_plan_invalid_contract"],
		[JSON.stringify({ ...plan, prompt: "   " }), "image_prompt_empty"],
	] as const) {
		const h = setup({ planValue });
		const { id } = await h.start();
		await until(settled(h, id));
		expect(h.image.get(id)).toMatchObject({
			state: "failed",
			phase: "failed",
			errorCode: code,
		});
		expect(h.executed).toEqual([]);
		expect(h.finished).toEqual(["run-1"]);
		await h.queue.close(100);
	}
});

test("generation fails when the catalog has no usable image service or returns no image", async () => {
	const missing = setup({ targets: [] });
	const noDescription = setup({ targets: [{ ...target, description: " " }] });
	const wrongMime = setup({ output: { mime: "text/plain" } });
	const empty = setup({ output: { bytes: new Uint8Array() } });
	for (const [h, code] of [
		[missing, "image_service_unavailable"],
		[noDescription, "image_service_unavailable"],
		[wrongMime, "image_content_missing"],
		[empty, "image_content_missing"],
	] as const) {
		const { id } = await h.start();
		await until(settled(h, id));
		expect(h.image.get(id)).toMatchObject({ state: "failed", errorCode: code });
		await h.queue.close(100);
	}
});

test("a revoked capability fails the record before any generation", async () => {
	const h = setup({
		validate: () => {
			throw new Error("capability_unavailable");
		},
	});
	const { id } = await h.start();
	await until(settled(h, id));
	expect(h.image.get(id)?.state).toBe("failed");
	expect(h.executed).toEqual([]);
	await h.queue.close(100);
});

test("a plan whose inference receipt is no longer acceptable is invalidated", async () => {
	const h = setup({ accept: false });
	const { id } = await h.start();
	await until(settled(h, id));
	expect(h.image.get(id)).toMatchObject({
		state: "failed",
		errorCode: "image_plan_invalidated",
	});
	expect(h.executed).toEqual([]);
	await h.queue.close(100);
});

test("list is scoped to the conversation, newest first, and exposed to screens", async () => {
	const h = setup({ targets: [] });
	const a = await h.start("run-a", "one");
	const b = await h.start("run-b", "one");
	await h.start("run-c", "two");
	expect(h.image.list("one").map((r) => r.id)).toEqual([b.id, a.id]);
	expect(h.image.list("none")).toEqual([]);
	expect(
		h.store.read((db) => imageListInTransaction(db, "two")).map((r) => r.runId),
	).toEqual(["run-c"]);
	expect(h.image.get("missing")).toBeNull();
	await h.queue.close(100);
});

test("the content route validates ids and maps library failures to stable errors", async () => {
	const h = setup({
		images: {
			remove: async (id: string) => {
				if (id === "gone") throw new Error("larm_http_404");
				if (id === "down") throw new Error("boom");
				return { id, deleted: true } as never;
			},
			list: async () => {
				throw new Error("offline");
			},
			get: async (id: string) => {
				if (id === "bad") throw new Error("offline");
				return {
					id,
					contentUrl: `/c/${id}`,
					mimeType: "image/webp",
					model: "m",
				} as never;
			},
		},
	});
	const app = new Hono();
	registerImage(app, h.image);
	expect((await app.request("/api/images/%20bad/content")).status).toBe(400);
	expect((await app.request("/api/images/bad/content")).status).toBe(502);
	const ok = await app.request("/api/images/fine/content");
	expect(ok.status).toBe(200);
	expect(ok.headers.get("content-type")).toBe("image/webp");
	expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
	expect(ok.headers.get("content-disposition")).toContain("image-fine.webp");
	expect(await ok.json().catch(() => null)).toBeNull();

	const deleted = await app.request("/api/images/fine", { method: "DELETE" });
	expect(await deleted.json()).toEqual({ id: "fine", deleted: true });
	expect(
		(await app.request("/api/images/gone", { method: "DELETE" })).status,
	).toBe(404);
	expect(
		(await app.request("/api/images/down", { method: "DELETE" })).status,
	).toBe(502);
	expect(
		(await app.request("/api/images/-bad", { method: "DELETE" })).status,
	).toBe(400);
	expect((await app.request("/api/images/library")).status).toBe(502);
	const listed = await app.request(
		"/api/images/generations?conversationId=none",
	);
	expect(await listed.json()).toEqual([]);
	await h.queue.close(100);
});
