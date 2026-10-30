import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createVisualPerception, type PerceptionPort } from "../../larm";
import { visualFetcher, visualImage, visualResult } from "./analyses.fixture";
import { createObjectRecognition, migrations } from "..";
import { registerRecognitionAnalyses } from "../controller/analyses";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const f of close.splice(0)) await f();
});
async function fixture(
	port?: PerceptionPort,
	allowAnalysis = true,
	fetchOptions?: Parameters<typeof visualFetcher>[0],
) {
	const dir = mkdtempSync(join(tmpdir(), "analysis-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 2,
		resources: { "vision.perception": allowAnalysis ? 1 : 0 },
	});
	const f = visualFetcher(fetchOptions);
	let version = "one";
	const p =
		port ??
		createVisualPerception({
			baseUrl: "http://127.0.0.1:9810",
			token: "control-secret",
			audience: "desktop",
			fetch: f.fetcher,
			pollMs: 1,
		});
	const service = createObjectRecognition({
		store,
		queue,
		connection: () => ({
			revision: 1,
			baseUrl: "http://127.0.0.1:9",
			credential: "test",
		}),
		visual: () => ({ ...p, version: () => version }),
		fetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 8,
				height: 6,
				objects: [],
			})) as unknown as typeof fetch,
	});
	queue.start();
	close.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const image = await visualImage();
	const id = crypto.randomUUID();
	await service.upload(
		"alice",
		"main",
		new File([image.bytes], "image.png", { type: "image/png" }),
		id,
	);
	await waitFor(() => service.get("alice", id).state === "completed");
	const source = service.get("alice", id);
	const a = service.analyses!;
	return {
		a,
		source,
		service,
		store,
		queue,
		f,
		change: () => {
			version = "two";
		},
		input: (task: "describe" | "segmentation" = "describe") => ({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			expectedRevision: source.revision,
			task,
			query: "説明",
		}),
	};
}
test("an invalid provider result persists as a contract failure and releases without retrying", async () => {
	const h = await fixture(undefined, true, {
		infer: async () => {
			const result = await visualResult();
			const execution: Record<string, unknown> = { ...result.execution };
			delete execution.decoderDtype;
			delete execution.visualTokens;
			return Response.json({ ...result, execution });
		},
	});
	const created = await h.a.create("alice", h.source.id, h.input("describe"));
	await waitFor(
		() => h.a.get("alice", h.source.id, created.id, "main").state === "failed",
	);
	const saved = h.a.get("alice", h.source.id, created.id, "main");
	expect(saved.errorCode).toBe("invalid_visual_response");
	expect(saved.result).toBeNull();
	expect(saved.releaseConfirmed).toBe(true);
	expect(
		h.f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(1);
	expect(h.f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
test("object-recognition detail analysis persists separately, reopens without inference, and exposes authenticated mask/image routes", async () => {
	const h = await fixture(),
		input = h.input("segmentation");
	const created = await h.a.create("alice", h.source.id, input);
	await waitFor(
		() =>
			h.a.get("alice", h.source.id, created.id, "main").state === "completed",
	);
	const saved = h.a.get("alice", h.source.id, created.id, "main");
	expect(saved.result?.masks[0]?.detectionIndex).toBe(1);
	expect(saved.releaseConfirmed).toBe(true);
	await waitFor(
		() =>
			h.a.get("alice", h.source.id, created.id, "main").stopObservation
				?.status === "cold",
	);
	expect(h.service.get("alice", h.source.id).revision).toBe(h.source.revision);
	expect(await h.a.create("alice", h.source.id, input)).toEqual(
		h.a.get("alice", h.source.id, created.id, "main"),
	);
	expect(
		h.f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(1);
	const app = new Hono();
	registerRecognitionAnalyses(app, h.a, "alice");
	const root = `/api/object-recognition/${h.source.id}/analyses/${created.id}`;
	const result = await app.request(`${root}?conversationId=main`);
	expect(result.status).toBe(200);
	const body = await result.json();
	expect(body.result.masks[0].data).toBe("");
	expect(JSON.stringify(body)).not.toContain("secret");
	const mask = await app.request(`${root}/masks/0?conversationId=main`);
	expect(mask.headers.get("Content-Type")).toBe("image/png");
	expect((await mask.arrayBuffer()).byteLength).toBeGreaterThan(0);
	const image = await app.request(`${root}/image?conversationId=main`);
	expect(image.status).toBe(200);
	expect(image.headers.get("Cache-Control")).toBe("no-store");
	expect(() => h.a.get("bob", h.source.id, created.id, "main")).toThrow();
	expect(() => h.a.get("alice", h.source.id, created.id, "other")).toThrow();
	await expect(
		h.a.create("alice", h.source.id, { ...input, query: "different" }),
	).rejects.toThrow("request_conflict");
	await expect(
		h.a.create("alice", h.source.id, { ...h.input(), expectedRevision: 0 }),
	).rejects.toThrow("revision_conflict");
});
test("object-recognition cancelling a running analysis rejects its late result and frees the connection", async () => {
	let entered!: () => void, done!: () => void;
	const ready = new Promise<void>((r) => (entered = r)),
		gate = new Promise<void>((r) => (done = r));
	const port: PerceptionPort = {
		version: () => "one",
		release: async () => {},
		perceive: async (_image, _options, _signal, progress) => {
			await progress("connection", "late-connection");
			await progress("running");
			entered();
			await gate;
			await progress("released");
			await progress("lifecycle", undefined, {
				status: "cold",
				connectionId: "late-connection",
				checkedAt: Date.now(),
			});
			return {
				result: await visualResult(),
				releaseConfirmed: true,
				elapsedMs: 1,
				waitingMs: 0,
				inferenceMs: 1,
			};
		},
	};
	const h = await fixture(port),
		r = await h.a.create("alice", h.source.id, h.input());
	await ready;
	await h.a.cancel("alice", h.source.id, r.id, "main");
	done();
	await waitFor(
		() =>
			h.a.get("alice", h.source.id, r.id, "main").state === "cancelled" &&
			h.a.get("alice", h.source.id, r.id, "main").releaseConfirmed === true &&
			h.a.get("alice", h.source.id, r.id, "main").stopObservation?.status ===
				"cold",
	);
	expect(
		h.a.get("alice", h.source.id, r.id, "main").stopObservation?.status,
	).toBe("cold");
	expect(h.a.get("alice", h.source.id, r.id, "main").result).toBeNull();
	expect(h.a.get("alice", h.source.id, r.id, "main").releaseConfirmed).toBe(
		true,
	);
});
test("object-recognition deleting a source cancels analysis and never resurrects late data", async () => {
	let entered!: () => void, done!: () => void;
	const ready = new Promise<void>((r) => (entered = r)),
		gate = new Promise<void>((r) => (done = r));
	const port: PerceptionPort = {
		version: () => "one",
		release: async () => {},
		perceive: async (_image, _options, _signal, progress) => {
			await progress("running");
			entered();
			await gate;
			await progress("released");
			return {
				result: await visualResult(),
				releaseConfirmed: true,
				elapsedMs: 1,
				waitingMs: 0,
				inferenceMs: 1,
			};
		},
	};
	const h = await fixture(port),
		r = await h.a.create("alice", h.source.id, h.input());
	await ready;
	await h.service.remove("alice", h.source.id);
	done();
	expect(() => h.a.get("alice", h.source.id, r.id, "main")).toThrow();
	expect(() => h.service.get("alice", h.source.id)).toThrow();
});
test("object-recognition LARM settings changes invalidate an in-flight response", async () => {
	let entered!: () => void, done!: () => void;
	const ready = new Promise<void>((r) => (entered = r)),
		gate = new Promise<void>((r) => (done = r));
	const port: PerceptionPort = {
		version: () => "one",
		release: async () => {},
		perceive: async (_image, _options, _signal, progress) => {
			await progress("running");
			entered();
			await gate;
			return {
				result: await visualResult(),
				releaseConfirmed: true,
				elapsedMs: 1,
				waitingMs: 0,
				inferenceMs: 1,
			};
		},
	};
	const h = await fixture(port),
		r = await h.a.create("alice", h.source.id, h.input());
	await ready;
	h.change();
	done();
	await waitFor(
		() => h.a.get("alice", h.source.id, r.id, "main").state === "failed",
	);
	expect(h.a.get("alice", h.source.id, r.id, "main").errorCode).toBe(
		"analysis_connection_changed",
	);
	expect(h.a.get("alice", h.source.id, r.id, "main").result).toBeNull();
});

test("object-recognition restart recovery releases a known connection without replaying inference", async () => {
	const released: string[] = [];
	const port: PerceptionPort = {
		version: () => "one",
		release: async (id) => {
			released.push(id);
		},
		perceive: async () => {
			throw new Error("must_not_infer");
		},
	};
	const h = await fixture(port, false);
	const r = await h.a.create("alice", h.source.id, h.input());
	await h.store.write((db) => {
		const saved = h.a.get("alice", h.source.id, r.id, "main");
		db.query(
			"UPDATE object_recognition_analyses SET connection_id=?,record_json=? WHERE id=?",
		).run(
			"owned-connection",
			JSON.stringify({ ...saved, state: "cancelled" }),
			r.id,
		);
	});
	await h.a.recover();
	expect(released).toEqual(["owned-connection"]);
	expect(h.a.get("alice", h.source.id, r.id, "main").releaseConfirmed).toBe(
		true,
	);
	expect(h.a.get("alice", h.source.id, r.id, "main").result).toBeNull();
});

test("object-recognition interrupted stop observation becomes unconfirmed without releasing again or replaying inference", async () => {
	let releases = 0;
	const h = await fixture(
		{
			version: () => "one",
			release: async () => {
				releases++;
			},
			perceive: async () => {
				throw new Error("must_not_infer");
			},
		},
		false,
	);
	const r = await h.a.create("alice", h.source.id, h.input());
	await h.store.write((db) => {
		const saved = h.a.get("alice", h.source.id, r.id, "main");
		db.query(
			"UPDATE object_recognition_analyses SET connection_id=?,record_json=? WHERE id=?",
		).run(
			"owned",
			JSON.stringify({
				...saved,
				state: "cancelled",
				releaseConfirmed: true,
				stopObservation: {
					status: "observing",
					connectionId: "owned",
					checkedAt: Date.now(),
				},
			}),
			r.id,
		);
	});
	await h.a.recover();
	expect(releases).toBe(0);
	expect(
		h.a.get("alice", h.source.id, r.id, "main").stopObservation,
	).toMatchObject({ status: "unconfirmed", reason: "observation_interrupted" });
});

test("object-recognition snapshot HTTP failure persists stop unconfirmed while preserving successful analysis", async () => {
	const h = await fixture(undefined, true, {
		snapshot: () => new Response(null, { status: 503 }),
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(
		() =>
			h.a.get("alice", h.source.id, r.id, "main").state === "completed" &&
			h.a.get("alice", h.source.id, r.id, "main").stopObservation?.status ===
				"unconfirmed",
	);
	const saved = h.a.get("alice", h.source.id, r.id, "main");
	expect(saved.releaseConfirmed).toBe(true);
	expect(saved.result).not.toBeNull();
	expect(saved.stopObservation).toMatchObject({
		status: "unconfirmed",
		reason: "observation_failed",
	});
});
