import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, migration, epochsMigration } from "..";
import type { Settings } from "../contracts";
import { settingsSchema } from "../contracts";
const cleanup: Array<() => Promise<void>> = [];
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
	).toBe(false);
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
