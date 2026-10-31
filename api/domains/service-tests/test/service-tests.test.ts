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
import { createServiceTests, registerServiceTests } from "..";
import { inputSchema, type StartTest } from "../contracts";
import { waitFor } from "../../../infrastructure/wait-for";
import { migration } from "../repository";
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
	selector: "image-profile",
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
type Harness = Awaited<ReturnType<typeof setup>>;
async function launched<T extends { run: unknown; launch?: () => boolean }>(
	accepted: T,
) {
	accepted.launch?.();
	return accepted.run as ReturnType<Harness["service"]["run"]> & object;
}
const start = async (
	h: Harness,
	raw: Parameters<Harness["service"]["startInTransaction"]>[1],
) =>
	launched(await h.store.write((db) => h.service.startInTransaction(db, raw)));
async function settled(h: Awaited<ReturnType<typeof setup>>, id: string) {
	await waitFor(() => h.service.run(id)!.status !== "running");
	return h.service.run(id)!;
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
	const a = await start(h, input);
	const b = await start(h, input);
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
		start(h, { ...input, input: { text: "different" } }),
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
	const a = await start(h, h.request());
	await waitFor(() => !!finish);
	await expect(start(h, h.request())).rejects.toThrow("invalid_test_busy");
	(await h.store.write((db) => h.service.cancelInTransaction(db, a.id)))();
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
	const a = await start(h, old);
	await waitFor(() => !!finish);
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
		start(h, { ...old, requestKey: crypto.randomUUID() }),
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
	const a = await start(h, h.request());
	expect((await settled(h, a.id)).status).toBe("result-unavailable");
	await launched(
		await h.store.write((db) => h.service.retryArtifactInTransaction(db, a.id)),
	);
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
	const a = await launched(
		await h.store.write((db) => h.service.diagnoseInTransaction(db)),
	);
	const r = await settled(h, a.id);
	expect(r.controlHealthy).toBe(true);
	expect(r.health?.[0]?.state).toBe("on-demand");
	expect(generated).toBe(0);
});
test("uploads are bounded and a start request refuses arbitrary URLs and unknown input fields", async () => {
	const h = await setup();
	const app = new Hono();
	registerServiceTests(app, h.service);
	await expect(
		start(h, { ...h.request(), url: "https://evil.test" } as never),
	).rejects.toThrow("invalid_test_input");
	expect(h.service.runs()).toHaveLength(0);
	expect(() => h.service.upload(new Uint8Array(50))).toThrow("invalid_upload");
	const upload = await app.request("/api/service-tests/uploads", {
		method: "POST",
		body: new Uint8Array(silentWav()),
	});
	expect(upload.status).toBe(201);
	const text = JSON.stringify(h.service.catalog());
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

test("image inputs accept arbitrary integer dimensions and reject values outside the service contract", () => {
	for (const size of [100, 777, 1200, 1280])
		expect(
			inputSchema.safeParse({
				text: "写真",
				width: size,
				height: size,
				seed: 42,
			}).success,
		).toBe(true);
	for (const size of [99, 1281, 777.5]) {
		expect(inputSchema.safeParse({ text: "写真", width: size }).success).toBe(
			false,
		);
		expect(inputSchema.safeParse({ text: "写真", height: size }).success).toBe(
			false,
		);
	}
});

test("Live blocks both speech test kinds without blocking image tests, and cancels an existing audio test", async () => {
	const speech = { ...target, id: "speech", kind: "tts" as const };
	const recognition = { ...speech, id: "recognition", kind: "asr" as const };
	let calls = 0;
	const h = await setup({
		catalog: async () => ({
			targets: [target, speech, recognition],
			errors: [],
			discoveredAt: Date.now(),
		}),
		execute: async (_t, _input, signal) => {
			calls++;
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			);
			return { text: "late" };
		},
	});
	let allowed = true;
	h.service.setVoiceAvailability(() => allowed);
	const run = await start(h, { ...h.request(), targetId: "speech" });
	await waitFor(() => calls === 1);
	allowed = false;
	await h.service.pauseVoice();
	expect((await settled(h, run.id)).status).toBe("cancelled");
	expect(h.service.preview(run.id)).toBeUndefined();
	expect(
		h.service.catalog().targets.find((t) => t.id === "speech"),
	).toMatchObject({ testable: false, reason: "live_legacy_voice_disabled" });
	await expect(
		start(h, { ...h.request(), targetId: "speech" }),
	).rejects.toThrow("live_legacy_voice_disabled");
	await expect(
		start(h, { ...h.request(), targetId: "recognition" }),
	).rejects.toThrow("live_legacy_voice_disabled");
	expect(calls).toBe(1);
	expect(
		h.service.catalog().targets.find((t) => t.id === "image")?.testable,
	).toBe(true);
	allowed = true;
	expect(
		h.service.catalog().targets.find((t) => t.id === "speech")?.testable,
	).toBe(true);
});
