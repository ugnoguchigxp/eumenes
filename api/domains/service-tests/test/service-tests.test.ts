import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration,
} from "../../settings";
import {
	createLarmPlayground,
	silentWav,
	type LarmPlayground,
	type LarmTestTarget,
} from "../../larm";
import { createServiceTests, migration, registerServiceTests } from "..";
import type { StartTest } from "../contracts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
const target: LarmTestTarget = {
	id: "image",
	name: "image",
	model: "sample-image",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	kind: "image",
	mode: "service",
	endpoint: "/v1/images/generations",
	profile: "profile",
	selector: "SAAA-w-Image",
	revision: "a".repeat(64),
	onDemand: true,
	primary: true,
};
async function setup(overrides: Partial<LarmPlayground> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-service-tests-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, [
		settingsMigration,
		epochsMigration,
		migration,
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const g: LarmPlayground = {
		...createLarmPlayground({
			baseUrl: "http://127.0.0.1:9",
			profile: "SAAA",
			audience: "same-host",
		}),
		catalog: async () => ({
			targets: [target],
			errors: [],
			discoveredAt: Date.now(),
		}),
		execute: async () => ({ text: "result" }),
		controlHealth: async () => true,
		health: async () => ({
			state: "on-demand",
			reason: "health_api_unavailable",
			checkedAt: Date.now(),
		}),
		...overrides,
	};
	const service = createServiceTests(
		store,
		settings,
		{ testResource: async () => "cloud result" },
		{ gateway: () => g },
	);
	await service.refresh();
	cleanup.push(async () => {
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const request = (): StartTest => ({
		targetId: "image",
		revision: settings.get().revision,
		requestKey: crypto.randomUUID(),
		input: { text: "private input" },
	});
	return { service, store, settings, g, request };
}
async function settled(h: Awaited<ReturnType<typeof setup>>, id: string) {
	for (let i = 0; i < 500; i++) {
		const r = h.service.run(id)!;
		if (r.status !== "running") return r;
		await Bun.sleep(2);
	}
	throw new Error("not_finished");
}
test("idempotent acceptance, isolated results and no plaintext input persistence", async () => {
	let calls = 0;
	const h = await setup({
		execute: async () => {
			calls++;
			return { text: "private output" };
		},
	});
	const input = h.request();
	const a = await h.service.start(input);
	const b = await h.service.start(input);
	expect(a.id).toBe(b.id);
	expect((await settled(h, a.id)).text).toBe("private output");
	expect(calls).toBe(1);
	const persisted = JSON.stringify(
		h.store.read((db) => db.query("SELECT * FROM service_test_runs").all()),
	);
	expect(persisted).not.toContain("private input");
	expect(persisted).not.toContain("private output");
	expect(JSON.stringify(h.service.runs())).not.toContain("/v1/images");
	await expect(
		h.service.start({ ...input, input: { text: "different" } }),
	).rejects.toThrow("invalid_request_key");
});
test("busy rejection and cancelled late result never becomes a preview", async () => {
	let finish!: () => void;
	const h = await setup({
		execute: async () => {
			await new Promise<void>((r) => (finish = r));
			return { text: "late" };
		},
	});
	const a = await h.service.start(h.request());
	for (let i = 0; !finish && i < 100; i++) await Bun.sleep(1);
	await expect(h.service.start(h.request())).rejects.toThrow(
		"invalid_test_busy",
	);
	await h.service.cancel(a.id);
	finish();
	const r = await settled(h, a.id);
	expect(r.status).toBe("cancelled");
	expect(r.previewAvailable).toBe(false);
});
test("settings changes invalidate in-flight results and stale requests", async () => {
	let finish!: () => void;
	const h = await setup({
		execute: async () => {
			await new Promise<void>((r) => (finish = r));
			return { text: "late" };
		},
	});
	const old = h.request();
	const a = await h.service.start(old);
	for (let i = 0; !finish && i < 100; i++) await Bun.sleep(1);
	const s = h.settings.get();
	s.larm.profile = "SAAA";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	finish();
	expect((await settled(h, a.id)).previewAvailable).toBe(false);
	expect(h.service.catalog().stale).toBe(true);
	await expect(
		h.service.start({ ...old, requestKey: crypto.randomUUID() }),
	).rejects.toThrow("invalid_stale_settings");
});
test("artifact retry uses GET adapter only, not generation", async () => {
	let generated = 0,
		downloaded = 0;
	const h = await setup({
		execute: async (_t, _i, _s, p) => {
			generated++;
			await p({
				phase: "fetching-result",
				artifact: {
					id: "a",
					path: "/v1/image-artifacts/a/content",
					mime: "image/png",
				},
			});
			throw new TypeError("offline");
		},
		artifact: async () => {
			downloaded++;
			return { bytes: new Uint8Array([1]), mime: "image/png" };
		},
	});
	const a = await h.service.start(h.request());
	expect((await settled(h, a.id)).status).toBe("result-unavailable");
	await h.service.retryArtifact(a.id);
	expect((await settled(h, a.id)).status).toBe("succeeded");
	expect(generated).toBe(1);
	expect(downloaded).toBe(1);
});
test("diagnostics persist individual Health states without generation", async () => {
	let generated = 0;
	const h = await setup({
		execute: async () => {
			generated++;
			return { text: "bad" };
		},
	});
	const a = await h.service.diagnose();
	const r = await settled(h, a.id);
	expect(r.controlHealthy).toBe(true);
	expect(r.health?.[0]?.state).toBe("on-demand");
	expect(generated).toBe(0);
});
test("controller bounds uploads and rejects arbitrary URLs and unknown input fields", async () => {
	const h = await setup();
	const app = new Hono();
	registerServiceTests(app, h.service);
	const bad = await app.request("/api/service-tests/runs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...h.request(), url: "https://evil.test" }),
	});
	expect(bad.status).toBe(400);
	expect(h.service.runs()).toHaveLength(0);
	expect(() => h.service.upload(new Uint8Array(50))).toThrow("invalid_upload");
	const upload = await app.request("/api/service-tests/uploads", {
		method: "POST",
		body: new Uint8Array(silentWav()),
	});
	expect(upload.status).toBe(201);
	const cat = await app.request("/api/service-tests/catalog");
	const text = await cat.text();
	expect(text).not.toContain("endpoint");
	expect(text).not.toContain("selector");
});
test("crash recovery resumes a known music job without resubmitting POST", async () => {
	let resumes = 0;
	const h = await setup({
		musicJob: async () => {
			resumes++;
			return { text: "recovered" };
		},
	});
	const record = {
		id: "recover",
		targetId: "music",
		model: "music",
		kind: "music",
		status: "running",
		phase: "generating",
		created: Date.now(),
		revision: h.settings.get().revision,
		jobId: "job",
		target: { ...target, kind: "music" },
	};
	await h.store.write((db) =>
		db
			.query("INSERT INTO service_test_runs VALUES(?,?,?,?,?)")
			.run("recover", "key", "hash", Date.now(), JSON.stringify(record)),
	);
	await h.service.recover();
	expect((await settled(h, "recover")).status).toBe("succeeded");
	expect(resumes).toBe(1);
});
