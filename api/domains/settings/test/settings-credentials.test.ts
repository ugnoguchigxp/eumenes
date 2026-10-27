import { afterEach, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, migration, epochsMigration, readStoredLarm } from "..";
import type { Settings } from "../contracts";
import { settingsSchema } from "../contracts";
import {
	cleanup,
	claude,
	cloud,
	credentialRows,
	save,
	setup,
} from "./settings.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
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
	legacy.subagent = { resourceId: managedResource };
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
	// The removed dedicated LLM selections are dropped; agency keeps its other fields.
	expect("enabled" in migrated.agency).toBe(false);
	expect("resourceId" in migrated.agency).toBe(false);
	expect(migrated.agency.idleSec).toBe(20);
	expect("subagent" in migrated).toBe(false);
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
	// A World model on another billing path than the conversation route are stored.
	const next = h.settings.get();
	next.world.curationResourceId = idle.resource;
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

test("the removed dedicated LLM selections are not part of the settings document", async () => {
	const h = await setup();
	const s = h.settings.get();
	expect("subagent" in s).toBe(false);
	expect("resourceId" in s.agency).toBe(false);
	expect("enabled" in s.agency).toBe(false);
	expect(
		settingsSchema.safeParse({ ...s, subagent: { resourceId: null } }).success,
	).toBe(false);
	expect(
		settingsSchema.safeParse({
			...s,
			agency: { ...s.agency, resourceId: null },
		}).success,
	).toBe(false);
	expect(
		settingsSchema.safeParse({
			...s,
			agency: { ...s.agency, enabled: true },
		}).success,
	).toBe(false);
});

test("agency defaults, also for saved documents without it", async () => {
	const h = await setup();
	const defaultAgency = {
		idleSec: 20,
		maxUnanswered: 1,
		interests: [],
		emotion: true,
	};
	expect(h.settings.get().agency).toEqual(defaultAgency);
	// A document saved before this setting existed still loads, with the agency defaults.
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
	partial.agency = { idleSec: 5 };
	expect(settingsSchema.parse(partial).agency).toEqual({
		...defaultAgency,
		idleSec: 5,
	});
});

test("agency persists through apply", async () => {
	const h = await setup();
	const s = h.settings.get();
	s.agency = {
		idleSec: 0,
		maxUnanswered: 10,
		interests: ["a", "b", "c"],
		emotion: false,
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
	expect(withAgency({ extra: 1 })).toBe(false);
});
