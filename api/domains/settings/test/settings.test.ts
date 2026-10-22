import { afterEach, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration,
	epochsMigration,
	readStoredLarm,
	readStoredWorldEnabled,
	registerSettings,
} from "..";
import { defaults } from "../service";
import type { Settings } from "../contracts";
import { applySchema, cloudEndpoint, settingsSchema } from "../contracts";
const cleanup: Array<() => Promise<void>> = [];
test("background selection persists without changing inference permissions; old documents remain valid", async () => {
	const h = await setup();
	const original = h.settings.get();
	expect(original.general.background).toBe("light-fairy");
	const legacy = structuredClone(original);
	delete legacy.general.background;
	expect(settingsSchema.parse(legacy).general.background).toBeUndefined();
	for (const background of ["spatial", "light-fairy"] as const) {
		const settings = h.settings.get();
		settings.general.background = background;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const reopened = await createSettings(h.store, {
			dbPath: h.dbPath,
			env: {},
		});
		expect(reopened.get().general.background).toBe(background);
		expect(reopened.get().routes).toEqual(original.routes);
		expect(reopened.get().larm).toEqual(original.larm);
	}
	expect(
		settingsSchema.safeParse({
			...original,
			general: { ...original.general, background: "unknown-background" },
		}).success,
	).toBe(false);
});
test("a fresh install has no profile; the env import and saved choices survive reopening", async () => {
	expect(defaults({}).larm.profile).toBeUndefined();
	expect(defaults({ LARM_PROFILE: " " }).larm.profile).toBeUndefined();
	expect(defaults({ LARM_PROFILE: "env-profile" }).larm.profile).toBe(
		"env-profile",
	);
	const h = await setup();
	expect(h.settings.get().larm.profile).toBeUndefined();
	const missing = structuredClone(h.settings.get()) as {
		larm: { profile?: string };
	};
	delete missing.larm.profile;
	expect(settingsSchema.parse(missing).larm.profile).toBeUndefined();
	for (const profile of ["test-profile", "test-profile-large"]) {
		const s = h.settings.get();
		s.larm.profile = profile;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: s.revision,
			settings: s,
			keys: [],
		});
		const reopened = await createSettings(h.store, {
			dbPath: h.dbPath,
			env: { LARM_PROFILE: "different-env-profile" },
		});
		expect(reopened.get().larm.profile).toBe(profile);
	}
});
test("same-host can start unconfigured while configured URLs still require loopback", () => {
	const settings = defaults({ LARM_AUDIENCE: "same-host" });
	expect(settings.larm.baseUrl).toBeNull();
	for (const baseUrl of ["http://192.168.1.10", "http://device.local"])
		expect(
			settingsSchema.safeParse({
				...settings,
				larm: { ...settings.larm, baseUrl },
			}).success,
		).toBe(false);
	expect(
		settingsSchema.safeParse({
			...settings,
			larm: { ...settings.larm, baseUrl: "http://127.0.0.1:9810" },
		}).success,
	).toBe(true);
});
test("backend live evaluation reads the saved LARM connection without changing settings", async () => {
	const h = await setup();
	const saved = h.settings.get();
	expect(saved.larm.baseUrl).toBeNull();
	saved.larm.baseUrl = "http://127.0.0.1:9810";
	saved.larm.profile = "saved-profile";
	saved.larm.audience = "same-host";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	const before = h.settings.get();
	expect(readStoredLarm(h.dbPath)).toEqual(before.larm);
	expect(h.settings.get()).toEqual(before);
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().larm).toEqual(before.larm);
});
test("new voice settings wait for a conversational pause and retain a saved custom interval", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect(s.voice.silenceMs).toBe(1500);
	s.voice.silenceMs = 700;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().voice.silenceMs).toBe(700);
});
test("old settings retain normal playback; speech adjustments validate and persist", async () => {
	const h = await setup();
	const old = JSON.parse(JSON.stringify(h.settings.get()));
	delete old.voice.outputVolume;
	delete old.larm.speed;
	expect(settingsSchema.parse(old).voice.outputVolume).toBe(1);
	const s = settingsSchema.parse(old);
	s.voice.outputVolume = 0;
	s.larm.voice = "selected-voice";
	s.larm.speed = 1.4;
	s.larm.style = "sweet";
	s.larm.pitchScale = 0.03;
	s.larm.intonationScale = 1.15;
	s.larm.autoIntonation = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().larm).toMatchObject({
		voice: "selected-voice",
		speed: 1.4,
		style: "sweet",
		pitchScale: 0.03,
		intonationScale: 1.15,
		autoIntonation: true,
	});
	expect(reopened.get().voice.outputVolume).toBe(0);
	for (const speed of [0, 2.1, NaN])
		expect(
			settingsSchema.safeParse({ ...s, larm: { ...s.larm, speed } }).success,
		).toBe(false);
	for (const outputVolume of [-0.1, 1.1, NaN])
		expect(
			settingsSchema.safeParse({ ...s, voice: { ...s.voice, outputVolume } })
				.success,
		).toBe(false);
});
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("coding supervision instruction approval defaults to on, including for saved documents without it", async () => {
	const h = await setup();
	expect(h.settings.get().codingSupervision.approveInstructions).toBe(true);
	// A document saved before this setting existed still loads, with approval on.
	const legacy = JSON.parse(JSON.stringify(h.settings.get()));
	delete legacy.codingSupervision;
	await h.store.write((db) => {
		db.query("UPDATE settings_document SET document=? WHERE id=1").run(
			JSON.stringify(legacy),
		);
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().codingSupervision.approveInstructions).toBe(true);
	const s = reopened.get();
	s.codingSupervision.approveInstructions = false;
	await reopened.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.get().codingSupervision.approveInstructions).toBe(false);
	expect(
		settingsSchema.safeParse({ ...s, codingSupervision: { extra: 1 } }).success,
	).toBe(false);
});
test("world.enabled defaults to false (also for saved documents without it), persists through apply and is what startup reads", async () => {
	const h = await setup();
	expect(h.settings.get().world).toEqual({
		enabled: false,
		curationResourceId: null,
	});
	expect(readStoredWorldEnabled(h.store)).toBe(false);
	// A document saved before this setting existed still loads, with World off.
	const legacy = JSON.parse(JSON.stringify(h.settings.get()));
	delete legacy.world;
	await h.store.write((db) => {
		db.query("UPDATE settings_document SET document=? WHERE id=1").run(
			JSON.stringify(legacy),
		);
	});
	expect(readStoredWorldEnabled(h.store)).toBe(false);
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	const s = reopened.get();
	s.world.enabled = true;
	await reopened.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	expect(readStoredWorldEnabled(h.store)).toBe(true);
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.get().world.enabled).toBe(true);
	expect(
		settingsSchema.safeParse({ ...s, world: { enabled: "yes" } }).success,
	).toBe(false);
	expect(
		settingsSchema.safeParse({ ...s, world: { enabled: true, extra: 1 } })
			.success,
	).toBe(false);
});
test("the settings API saves world.enabled and returns it", async () => {
	const h = await setup();
	const app = new Hono();
	registerSettings(app, h.settings);
	const s = h.settings.get();
	s.world.enabled = true;
	const response = await app.request("/api/settings/apply", {
		method: "POST",
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			expectedRevision: s.revision,
			settings: s,
			keys: [],
		}),
	});
	expect(response.status).toBe(200);
	expect(((await response.json()) as Settings).world.enabled).toBe(true);
	const saved = (await (await app.request("/api/settings")).json()) as Settings;
	expect(saved.world).toEqual({ enabled: true, curationResourceId: null });
	expect(readStoredWorldEnabled(h.store)).toBe(true);
});
test("readStoredWorldEnabled is false while no settings document exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-world-"));
	const store = openStore(join(dir, "test.db"), [migration, epochsMigration]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	expect(readStoredWorldEnabled(store)).toBe(false);
});
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [migration, epochsMigration]);
	const settings = await createSettings(store, { dbPath, env: {} });
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, dbPath, store, settings };
}
function cloud(s: Settings) {
	const c = crypto.randomUUID();
	const r = crypto.randomUUID();
	s.connections.push({
		id: c,
		name: "Test",
		baseUrl: "https://example.test/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	s.resources.push({
		id: r,
		connectionId: c,
		purpose: "llm",
		model: "test",
		contextWindow: 8192,
		voice: null,
	});
	s.routes.llm.fallbackId = r;
	return c;
}
test("bootstraps once; atomic revision and idempotency; encrypted secret never in document", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect(s.routes.llm.cloudAllowed).toBe(true);
	const c = cloud(s);
	const input = {
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-cloud-secret" }],
	};
	const saved = await h.settings.apply(input);
	expect(saved.revision).toBe(1);
	expect(await h.settings.apply(input)).toEqual(saved);
	expect(h.settings.credential(saved.connections[0]!)).toBe(
		"fixture-cloud-secret",
	);
	expect(JSON.stringify(h.settings.get())).not.toContain(
		"fixture-cloud-secret",
	);
	const rows = h.store.read((db) =>
		db.query("SELECT * FROM settings_credentials").all(),
	);
	expect(JSON.stringify(rows)).not.toContain("fixture-cloud-secret");
	expect(readFileSync(join(h.dir, "keys/settings.key")).length).toBe(32);
	expect(statSync(join(h.dir, "keys/settings.key")).mode & 0o777).toBe(0o600);
	// Created atomically: no temp file is left beside the key.
	expect(readdirSync(join(h.dir, "keys"))).toEqual(["settings.key"]);
	await expect(
		h.settings.apply({
			...input,
			settings: { ...s, general: { ...s.general, theme: "dark" } },
		}),
	).rejects.toThrow("request_conflict");
	await expect(
		h.settings.apply({ ...input, requestId: crypto.randomUUID() }),
	).rejects.toThrow("revision_conflict");
	expect(h.settings.get()).toEqual(saved);
});
test("revocation epochs cannot be reset by client; origin changes cannot reuse credential", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	let saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	const changed = structuredClone(saved);
	changed.connections[0]!.baseUrl = "https://other.test/v1";
	await expect(
		h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: 1,
			settings: changed,
			keys: [],
		}),
	).rejects.toThrow("invalid_origin_requires_new_key");
	const old = structuredClone(saved);
	saved.routes.llm.cloudAllowed = false;
	saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 1,
		settings: saved,
		keys: [],
	});
	saved.routes.llm.cloudAllowed = true;
	saved.routes.llm.epoch = 0;
	saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 2,
		settings: saved,
		keys: [],
	});
	expect(saved.routes.llm.epoch).toBe(1);
	expect(
		h.store.read((db) => h.settings.valid(db, old, "llm", old.connections[0])),
	).toBe(false);
});
test("missing or wrong master key preserves data, disables ciphertext and does not regenerate", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	const saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	unlinkSync(join(h.dir, "keys/settings.key"));
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.diagnostics().keyError).toBe("secret_key_unavailable");
	expect(reopened.credential(saved.connections[0]!)).toBeNull();
	expect(reopened.get()).toEqual(saved);
	const wrong = await createSettings(h.store, {
		dbPath: h.dbPath,
		env: { EUMENES_SECRET_KEY: Buffer.alloc(32).toString("base64") },
	});
	expect(wrong.diagnostics().keyError).toBe("secret_key_unavailable");
});

test("deleting then recreating the same connection ID cannot revive old permissions", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	const saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	const deleted = structuredClone(saved);
	deleted.connections = [];
	deleted.resources = [];
	deleted.routes.llm.fallbackId = null;
	const removed = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: deleted,
		keys: [],
	});
	const recreated = structuredClone(saved);
	recreated.revision = removed.revision;
	const restored = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: removed.revision,
		settings: recreated,
		keys: [],
	});
	expect(restored.connections[0]!.epoch).toBeGreaterThan(
		saved.connections[0]!.epoch,
	);
	expect(
		h.store.read((db) =>
			h.settings.valid(db, saved, "llm", saved.connections[0]),
		),
	).toBe(false);
});

test("malformed LARM URLs are validation errors and same-host requires loopback", async () => {
	const h = await setup();
	const s = h.settings.get();
	for (const baseUrl of ["bad-url", "", "https://public.example"])
		await expect(
			h.settings.apply({
				requestId: crypto.randomUUID(),
				expectedRevision: 0,
				settings: { ...s, larm: { ...s.larm, baseUrl } },
				keys: [],
			}),
		).rejects.toThrow();
	// safeParse must return an issue instead of throwing from URL construction.
	const { settingsSchema } = await import("../contracts");
	expect(
		settingsSchema.safeParse({ ...s, larm: { ...s.larm, baseUrl: "bad-url" } })
			.success,
	).toBe(false);
	expect(
		settingsSchema.safeParse({
			...s,
			larm: { ...s.larm, audience: "same-host", baseUrl: null },
		}).success,
	).toBe(true);
});

test("key replacement, key deletion and connection deletion discard obsolete ciphertext", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	const apply = (
		settings: Settings,
		keys: Array<{ connectionId: string; value: string | null }>,
	) =>
		h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys,
		});
	const count = () =>
		h.store.read(
			(db) =>
				(
					db.query("SELECT count(*) AS n FROM settings_credentials").get() as {
						n: number;
					}
				).n,
		);
	let saved = await apply(s, [{ connectionId: c, value: "first-key" }]);
	saved = await apply(saved, [{ connectionId: c, value: "replacement-key" }]);
	expect(count()).toBe(1);
	expect(h.settings.credential(saved.connections[0]!)).toBe("replacement-key");
	saved = await apply(saved, [{ connectionId: c, value: null }]);
	expect(count()).toBe(0);
	saved = await apply(saved, [{ connectionId: c, value: "last-key" }]);
	saved.connections = [];
	saved.resources = [];
	saved.routes.llm.fallbackId = null;
	await apply(saved, []);
	expect(count()).toBe(0);
	unlinkSync(join(h.dir, "keys/settings.key"));
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.diagnostics().keyError).toBeNull();
});

test("envRef must be allowlisted when saved and when resolved", async () => {
	const { isAllowedEnvRef } = await import("../service");
	const openai = "https://api.openai.com/v1";
	expect(isAllowedEnvRef("EUMENES_CLOUD_KEY", [], "https://evil.example")).toBe(
		true,
	);
	expect(isAllowedEnvRef("OPENAI_API_KEY", [], openai)).toBe(true);
	expect(isAllowedEnvRef("OPENAI_API_KEY", [], "https://evil.example")).toBe(
		false,
	);
	expect(isAllowedEnvRef("OPENAI_API_KEY", [], "not a url")).toBe(false);
	expect(isAllowedEnvRef("MY_KEY", ["MY_KEY"], "https://evil.example")).toBe(
		true,
	);
	expect(isAllowedEnvRef("PATH", [], openai)).toBe(false);
	expect(isAllowedEnvRef("AWS_SECRET_ACCESS_KEY", [], openai)).toBe(false);
	expect(isAllowedEnvRef("toString", [], openai)).toBe(false);

	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [migration, epochsMigration]);
	const settings = await createSettings(store, {
		dbPath,
		env: { AWS_SECRET_ACCESS_KEY: "x", OPENAI_API_KEY: "sk-test" },
	});
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const s = settings.get();
	const c = cloud(s);
	s.connections[0]!.envRef = "AWS_SECRET_ACCESS_KEY";
	await expect(
		settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: s,
			keys: [],
		}),
	).rejects.toThrow("invalid_env_ref");
	s.connections[0]!.envRef = "OPENAI_API_KEY";
	// A provider key cannot be pointed at a host that is not the provider's.
	await expect(
		settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: s,
			keys: [],
		}),
	).rejects.toThrow("invalid_env_ref");
	s.connections[0]!.baseUrl = "https://api.openai.com/v1";
	const saved = await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [],
	});
	expect(settings.credential(saved.connections[0]!)).toBe("sk-test");
	expect(String(saved.connections[0]!.id)).toBe(String(c));
	expect(() =>
		settings.credential({ ...saved.connections[0]!, envRef: "PATH" }),
	).toThrow("env_ref_not_allowed");
	// A saved connection whose host no longer matches fails on use.
	expect(() =>
		settings.credential({
			...saved.connections[0]!,
			baseUrl: "https://evil.example/v1",
		}),
	).toThrow("env_ref_not_allowed");
});

test("cloud connections require https outside private networks", () => {
	const ok = (baseUrl: string) => cloudEndpoint.safeParse(baseUrl).success;
	expect(ok("http://192.168.0.5")).toBe(true);
	expect(ok("http://localhost:8080")).toBe(true);
	expect(ok("http://foo.local")).toBe(true);
	expect(ok("http://172.20.1.1")).toBe(true);
	expect(ok("https://example.com")).toBe(true);
	expect(ok("http://example.com")).toBe(false);
	expect(ok("http://172.32.0.1")).toBe(false);
	expect(ok("http://169.254.169.254")).toBe(false);
});

test("a saved http cloud URL still loads, but applying it is rejected", async () => {
	const h = await setup();
	const s = h.settings.get();
	cloud(s);
	s.connections[0]!.baseUrl = "http://api.example.com/v1";
	expect(settingsSchema.safeParse(s).success).toBe(true);
	expect(
		applySchema.safeParse({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: s,
			keys: [],
		}).success,
	).toBe(false);
});

function credentialRows(h: Awaited<ReturnType<typeof setup>>) {
	return h.store.read(
		(db) =>
			db.query("SELECT id, encrypted FROM settings_credentials").all() as {
				id: string;
				encrypted: string;
			}[],
	);
}
test("credential ciphertext is bound to its row", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	const other = crypto.randomUUID();
	const saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	const [row] = credentialRows(h);
	expect(row!.encrypted.startsWith("v2.")).toBe(true);
	// Copy the ciphertext under another row id: it must not decrypt there.
	await h.store.write((db) =>
		db
			.query("INSERT INTO settings_credentials VALUES(?,?)")
			.run(`${other}:0`, row!.encrypted),
	);
	expect(() =>
		h.settings.credential({ ...saved.connections[0]!, id: other, epoch: 0 }),
	).toThrow();
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.diagnostics().keyError).toBe("secret_key_unavailable");
});

test("v1 ciphertext is upgraded to v2 on startup and survives restart", async () => {
	const h = await setup();
	const s = h.settings.get();
	const c = cloud(s);
	const saved = await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	const id = `${saved.connections[0]!.id}:${saved.connections[0]!.epoch}`;
	// Re-encrypt in the legacy (no AAD) format.
	const key = readFileSync(join(h.dir, "keys/settings.key"));
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const bytes = Buffer.concat([
		cipher.update("fixture-key", "utf8"),
		cipher.final(),
	]);
	const v1 = [iv, cipher.getAuthTag(), bytes]
		.map((b) => b.toString("base64"))
		.join(".");
	await h.store.write((db) =>
		db
			.query("UPDATE settings_credentials SET encrypted=? WHERE id=?")
			.run(v1, id),
	);
	const upgraded = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(upgraded.diagnostics().keyError).toBeNull();
	expect(upgraded.credential(saved.connections[0]!)).toBe("fixture-key");
	expect(credentialRows(h)[0]!.encrypted.startsWith("v2.")).toBe(true);
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.diagnostics().keyError).toBeNull();
	expect(again.credential(saved.connections[0]!)).toBe("fixture-key");
});

test("keyDir option and EUMENES_KEY_DIR relocate the master key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-"));
	const keys = mkdtempSync(join(tmpdir(), "eumenes-keys-"));
	const store = openStore(join(dir, "test.db"), [migration, epochsMigration]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
		rmSync(keys, { recursive: true, force: true });
	});
	await createSettings(store, {
		dbPath: join(dir, "test.db"),
		env: {},
		keyDir: join(keys, "a"),
	});
	expect(statSync(join(keys, "a/settings.key")).mode & 0o777).toBe(0o600);
	await createSettings(store, {
		dbPath: join(dir, "test.db"),
		env: { EUMENES_KEY_DIR: join(keys, "b") },
	});
	expect(statSync(join(keys, "b/settings.key")).size).toBe(32);
	expect(existsSync(join(dir, "keys"))).toBe(false);
});

test("a changed LARM origin needs an explicit confirmation; same origin or first setup does not", async () => {
	const h = await setup();
	const s = h.settings.get();
	s.larm.audience = "saaa-desktop";
	const save = (
		settings: Settings,
		extra: { confirmLarmOrigin?: string } = {},
	) =>
		h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: h.settings.get().revision,
			settings,
			keys: [],
			...extra,
		});
	s.larm.baseUrl = "http://192.168.0.10:9810";
	let saved = await save(s); // (d) first setup
	const moved = structuredClone(saved);
	moved.larm.baseUrl = "http://192.168.0.20:9810";
	await expect(save(moved)).rejects.toThrow("invalid_larm_origin_unconfirmed"); // (a)
	await expect(
		save(moved, { confirmLarmOrigin: "http://192.168.0.30:9810" }),
	).rejects.toThrow("invalid_larm_origin_unconfirmed");
	saved = await save(moved, { confirmLarmOrigin: "http://192.168.0.20:9810" }); // (b)
	const pathOnly = structuredClone(saved);
	pathOnly.larm.baseUrl = "http://192.168.0.20:9810/base";
	await save(pathOnly); // (c)
});
test("an Azure key is bound to one single-label host and one host per key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [migration, epochsMigration]);
	const settings = await createSettings(store, {
		dbPath,
		env: { AZURE_OPENAI_API_KEY: "x" },
	});
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const s = settings.get();
	cloud(s);
	cloud(s);
	for (const c of s.connections) c.envRef = "AZURE_OPENAI_API_KEY";
	const apply = (value: Settings) =>
		settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: value,
			keys: [],
		});
	s.connections[0]!.baseUrl = "https://evil.x.openai.azure.com/v1";
	s.connections[1]!.baseUrl = "https://b.openai.azure.com/v1";
	await expect(apply(s)).rejects.toThrow("invalid_env_ref");
	s.connections[0]!.baseUrl = "https://a.openai.azure.com/v1";
	await expect(apply(s)).rejects.toThrow("invalid_env_ref_host_conflict");
	s.connections.pop();
	s.resources.pop();
	s.routes.llm.fallbackId = s.resources[0]!.id;
	await apply(s);
});
test("settings_requests keeps only the newest 64 requests", async () => {
	const h = await setup();
	const first = crypto.randomUUID();
	let current = h.settings.get();
	const firstInput = {
		requestId: first,
		expectedRevision: 0,
		settings: structuredClone(current),
		keys: [],
	};
	current = await h.settings.apply(firstInput);
	let lastInput = firstInput;
	for (let i = 0; i < 69; i++) {
		lastInput = {
			requestId: crypto.randomUUID(),
			expectedRevision: current.revision,
			settings: structuredClone(current),
			keys: [],
		};
		current = await h.settings.apply(lastInput);
	}
	const count = h.store.read(
		(db) =>
			(
				db.query("SELECT count(*) AS n FROM settings_requests").get() as {
					n: number;
				}
			).n,
	);
	expect(await count).toBe(64);
	expect(await h.settings.apply(lastInput)).toEqual(current);
	await expect(h.settings.apply(firstInput)).rejects.toThrow(
		"revision_conflict",
	);
});

test("old settings keep English speech routing disabled and English settings persist independently", async () => {
	const h = await setup();
	const value = h.settings.get();
	expect(value.larm.englishSpeechEnabled ?? false).toBe(false);
	const japanese = {
		voice: value.larm.voice,
		style: value.larm.style,
		speed: value.larm.speed,
	};
	Object.assign(value.larm, {
		englishSpeechEnabled: true,
		englishVoice: "Rosie",
		englishMasculineVoice: "Jasper",
		englishSpeed: 1.2,
	});
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(readStoredLarm(h.dbPath)).toEqual(reopened.get().larm);
	expect(reopened.get().larm.voice).toBe(japanese.voice);
	expect(reopened.get().larm.style).toBe(japanese.style);
	expect(reopened.get().larm.speed).toBe(japanese.speed);
	expect(reopened.get().larm).toMatchObject({
		englishSpeechEnabled: true,
		englishVoice: "Rosie",
		englishMasculineVoice: "Jasper",
		englishSpeed: 1.2,
	});
	for (const englishSpeed of [0, 3, Infinity])
		expect(
			settingsSchema.safeParse({
				...value,
				larm: { ...value.larm, englishSpeed },
			}).success,
		).toBe(false);
});

test("a stored sentence-language switch migrates to englishSpeechEnabled and drops the classifier selector", async () => {
	const h = await setup();
	const raw = JSON.parse(
		(
			h.store.read((db) =>
				db.query("SELECT document FROM settings_document WHERE id=1").get(),
			) as { document: string }
		).document,
	);
	raw.larm.sentenceLanguageEnabled = true;
	raw.larm.sentenceLanguageProvider = "catalog-language";
	await h.store.write((db) => {
		db.query("UPDATE settings_document SET document=? WHERE id=1").run(
			JSON.stringify(raw),
		);
	});
	const migrated = readStoredLarm(h.dbPath);
	expect(migrated.englishSpeechEnabled).toBe(true);
	expect(migrated).not.toHaveProperty("sentenceLanguageEnabled");
	expect(migrated).not.toHaveProperty("sentenceLanguageProvider");
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().larm).toEqual(migrated);
});

test("world.curationResourceId must name a registered LLM resource", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect(
		settingsSchema.safeParse({
			...s,
			world: { enabled: true, curationResourceId: crypto.randomUUID() },
		}).success,
	).toBe(false);
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	const withResource = {
		...s,
		connections: [
			...s.connections,
			{
				id: connectionId,
				name: "Cloud",
				baseUrl: "https://example.com/v1",
				enabled: true,
				epoch: 0,
				envRef: null,
			},
		],
		resources: [
			...s.resources,
			{
				id: resourceId,
				connectionId,
				purpose: "llm" as const,
				model: "fixture-llm",
				contextWindow: 8192,
				voice: null,
			},
		],
		world: { enabled: true, curationResourceId: resourceId },
	};
	expect(settingsSchema.safeParse(withResource).success).toBe(true);
});

function claude(
	s: Settings,
	auth: "subscription" | "api-key",
	extra: Partial<Settings["connections"][number]> = {},
) {
	const connection = crypto.randomUUID();
	const resource = crypto.randomUUID();
	s.connections.push({
		id: connection,
		kind: "claude-agent-sdk",
		auth,
		name: `Claude ${auth}`,
		baseUrl: "https://claude.example.test",
		enabled: true,
		epoch: 0,
		envRef: null,
		...extra,
	});
	s.resources.push({
		id: resource,
		connectionId: connection,
		purpose: "llm",
		model: `claude-${auth}`,
		contextWindow: 8192,
		voice: null,
	});
	return { connection, resource };
}
const save = (
	h: Awaited<ReturnType<typeof setup>>,
	s: Settings,
	keys: Array<{ connectionId: string; value: string | null }> = [],
) =>
	h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys,
	});

test("auth is required exactly for Claude Agent SDK connections and a subscription takes no env ref", async () => {
	const h = await setup();
	const s = h.settings.get();
	const { connection } = claude(s, "api-key");
	expect(settingsSchema.safeParse(s).success).toBe(true);
	const conn = s.connections.find((c) => c.id === connection)!;
	delete conn.auth;
	expect(settingsSchema.safeParse(s).success).toBe(false);
	conn.auth = "subscription";
	conn.envRef = "EUMENES_CLOUD_KEY";
	expect(settingsSchema.safeParse(s).success).toBe(false);
	conn.envRef = null;
	expect(settingsSchema.safeParse(s).success).toBe(true);
	conn.kind = "codex-sdk";
	expect(settingsSchema.safeParse(s).success).toBe(false);
	conn.kind = undefined;
	expect(settingsSchema.safeParse(s).success).toBe(false);
});

test("stored settings are migrated once: Managed Agents removed, auth filled, nothing else changed", async () => {
	const h = await setup();
	const s = h.settings.get();
	const keyed = claude(s, "api-key");
	const bare = claude(s, "subscription");
	const viaEnv = claude(s, "api-key", { envRef: "EUMENES_CLOUD_KEY" });
	const managed = crypto.randomUUID();
	const managedResource = crypto.randomUUID();
	await save(h, s, [{ connectionId: keyed.connection, value: "sk-keep" }]);
	const kept = h.settings.get();
	const epoch = kept.connections.find((c) => c.id === managed)?.epoch;
	expect(epoch).toBeUndefined();
	// Rewrite the stored document into the shape before this change.
	const legacy = JSON.parse(JSON.stringify(kept));
	for (const c of legacy.connections) delete c.auth;
	delete legacy.subagent;
	legacy.connections.push({
		id: managed,
		kind: "claude-managed-agents",
		agentId: "agent_1",
		environmentId: "env_1",
		name: "Managed",
		baseUrl: "https://managed.example.test",
		enabled: true,
		epoch: 3,
		envRef: null,
	});
	legacy.resources.push({
		id: managedResource,
		connectionId: managed,
		purpose: "llm",
		model: "managed-model",
		contextWindow: 8192,
		voice: null,
	});
	legacy.routes.llm = {
		...legacy.routes.llm,
		mode: "cloud-only",
		fallbackId: managedResource,
	};
	legacy.world.curationResourceId = managedResource;
	legacy.agency = {
		enabled: true,
		resourceId: managedResource,
		idleSec: 20,
		maxUnanswered: 1,
		interests: [],
	};
	await h.store.write((db) => {
		db.query("UPDATE settings_document SET document=? WHERE id=1").run(
			JSON.stringify(legacy),
		);
		db.query("INSERT INTO settings_credentials VALUES(?,?)").run(
			`${managed}:3`,
			"orphan",
		);
	});
	// The read path migrates before the strict parse, even before startup persists it.
	const migrated = h.settings.get();
	expect(migrated.connections.map((c) => [c.id, c.auth])).toEqual([
		[keyed.connection, "api-key"],
		[bare.connection, "subscription"],
		[viaEnv.connection, "api-key"],
	]);
	expect(migrated.resources.map((r) => r.id)).not.toContain(managedResource);
	expect(migrated.routes.llm.fallbackId).toBeNull();
	expect(migrated.routes.llm.mode).toBe("larm-preferred");
	expect(migrated.world.curationResourceId).toBeNull();
	// Agency does not fall back to LARM silently: it is switched off.
	expect(migrated.agency.resourceId).toBeNull();
	expect(migrated.agency.enabled).toBe(false);
	expect(migrated.subagent).toEqual({ resourceId: null });
	expect(h.settings.credential(migrated.connections[0]!)).toBe("sk-keep");
	// Startup persists the migration once and drops the removed connection's secret.
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	const stored = JSON.parse(
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT document FROM settings_document WHERE id=1")
						.get() as {
						document: string;
					}
				).document,
		),
	);
	expect(JSON.stringify(stored)).not.toMatch(/managed|agentId|environmentId/i);
	expect(reopened.get()).toEqual(migrated);
	expect(
		h.store.read((db) =>
			db
				.query("SELECT 1 FROM settings_credentials WHERE id LIKE ?")
				.get(`${managed}:%`),
		),
	).toBeNull();
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT epoch FROM settings_connection_epochs WHERE id=?")
						.get(managed) as { epoch: number }
				).epoch,
		),
	).toBe(4);
	// A migrated document passes through unchanged and can be saved again.
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.get()).toEqual(migrated);
	await save(h, again.get());
});

test("a connection in use never changes its billing path in place; other changes of path are allowed", async () => {
	const h = await setup();
	const s = h.settings.get();
	const used = claude(s, "api-key");
	const idle = claude(s, "subscription");
	// LARM first with a cloud fallback is the existing explicit configuration.
	s.routes.llm.fallbackId = used.resource;
	await save(h, s, [
		{ connectionId: used.connection, value: "sk-used" },
		{ connectionId: idle.connection, value: "setup-token" },
	]);
	// A World and a sub-agent model on another billing path than the conversation route are stored.
	const next = h.settings.get();
	next.world.curationResourceId = idle.resource;
	next.subagent.resourceId = idle.resource;
	next.agency.resourceId = idle.resource;
	await save(h, next);
	// Switching a routed connection from API key to subscription is refused, key or not.
	const swapped = h.settings.get();
	swapped.connections.find((c) => c.id === used.connection)!.auth =
		"subscription";
	await expect(
		save(h, structuredClone(swapped), [
			{ connectionId: used.connection, value: "setup-token-2" },
		]),
	).rejects.toThrow("invalid_billing_path_change");
	// So is a dedicated model's connection.
	const dedicated = h.settings.get();
	dedicated.connections.find((c) => c.id === idle.connection)!.auth = "api-key";
	await expect(
		save(h, dedicated, [{ connectionId: idle.connection, value: "sk-idle" }]),
	).rejects.toThrow("invalid_billing_path_change");
	// Unassigned, the path may change; it takes a credential of the new method and drops the old.
	const free = h.settings.get();
	free.world.curationResourceId = null;
	free.subagent.resourceId = null;
	free.agency.resourceId = null;
	free.connections.find((c) => c.id === idle.connection)!.auth = "api-key";
	await expect(save(h, structuredClone(free))).rejects.toThrow(
		"credential_required",
	);
	await save(h, free, [{ connectionId: idle.connection, value: "sk-idle" }]);
	const saved = h.settings.get();
	const idleConnection = saved.connections.find(
		(c) => c.id === idle.connection,
	)!;
	expect(idleConnection.auth).toBe("api-key");
	expect(h.settings.credential(idleConnection)).toBe("sk-idle");
	// Without a new credential the old one does not carry over to the new method.
	const back = h.settings.get();
	back.connections.find((c) => c.id === idle.connection)!.auth = "subscription";
	await expect(save(h, back)).rejects.toThrow("credential_required");
	expect(
		h.settings.get().connections.find((c) => c.id === idle.connection)!.auth,
	).toBe("api-key");
});

test("subagent.resourceId must name a registered LLM resource and defaults to LARM", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect(s.subagent).toEqual({ resourceId: null });
	expect(
		settingsSchema.safeParse({
			...s,
			subagent: { resourceId: crypto.randomUUID() },
		}).success,
	).toBe(false);
	const { resource } = claude(s, "api-key", { envRef: "EUMENES_CLOUD_KEY" });
	s.subagent.resourceId = resource;
	expect(settingsSchema.safeParse(s).success).toBe(true);
	expect(
		settingsSchema.safeParse({ ...s, subagent: { resourceId: resource, x: 1 } })
			.success,
	).toBe(false);
	await save(h, s);
	expect(h.settings.get().subagent.resourceId).toBe(resource);
});

test("agency defaults to OFF on the LARM local LLM, also for saved documents without it", async () => {
	const h = await setup();
	const defaultAgency = {
		enabled: false,
		resourceId: null,
		idleSec: 20,
		maxUnanswered: 1,
		interests: [],
	};
	expect(h.settings.get().agency).toEqual(defaultAgency);
	// A document saved before this setting existed still loads, with agency off.
	const legacy = JSON.parse(JSON.stringify(h.settings.get()));
	delete legacy.agency;
	await h.store.write((db) => {
		db.query("UPDATE settings_document SET document=? WHERE id=1").run(
			JSON.stringify(legacy),
		);
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().agency).toEqual(defaultAgency);
	// A partial section fills the rest with the defaults.
	const partial = JSON.parse(JSON.stringify(legacy));
	partial.agency = { enabled: true };
	expect(settingsSchema.parse(partial).agency).toEqual({
		...defaultAgency,
		enabled: true,
	});
});

test("agency persists through apply; its resource must name a registered LLM resource", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect(
		settingsSchema.safeParse({
			...s,
			agency: { ...s.agency, resourceId: crypto.randomUUID() },
		}).success,
	).toBe(false);
	const { resource } = claude(s, "api-key", { envRef: "EUMENES_CLOUD_KEY" });
	s.agency = {
		enabled: true,
		resourceId: resource,
		idleSec: 0,
		maxUnanswered: 10,
		interests: ["a", "b", "c"],
	};
	expect(settingsSchema.safeParse(s).success).toBe(true);
	await save(h, s);
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.get().agency).toEqual(s.agency);
});

test("agency rejects out-of-range values and unknown fields", async () => {
	const h = await setup();
	const s = h.settings.get();
	const withAgency = (patch: Record<string, unknown>) =>
		settingsSchema.safeParse({ ...s, agency: { ...s.agency, ...patch } })
			.success;
	expect(withAgency({})).toBe(true);
	expect(withAgency({ idleSec: 86400 })).toBe(true);
	expect(withAgency({ idleSec: -1 })).toBe(false);
	expect(withAgency({ idleSec: 86401 })).toBe(false);
	expect(withAgency({ idleSec: 1.5 })).toBe(false);
	expect(withAgency({ maxUnanswered: 0 })).toBe(false);
	expect(withAgency({ maxUnanswered: 11 })).toBe(false);
	expect(withAgency({ maxUnanswered: 1.5 })).toBe(false);
	expect(withAgency({ interests: ["a", "b", "c", "d"] })).toBe(false);
	expect(withAgency({ interests: [""] })).toBe(false);
	expect(withAgency({ interests: ["x".repeat(200)] })).toBe(true);
	expect(withAgency({ interests: ["x".repeat(201)] })).toBe(false);
	expect(withAgency({ enabled: "yes" })).toBe(false);
	expect(withAgency({ resourceId: "not-a-uuid" })).toBe(false);
	expect(withAgency({ extra: 1 })).toBe(false);
});
