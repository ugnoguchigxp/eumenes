import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migrations,
	readStoredObjectRecognitionConnection,
} from "..";
test("dedicated gateway settings are encrypted, revision-bound, redacted and protected from missing/replaced master keys", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-recognition-settings-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	try {
		const s = await createSettings(store, { dbPath });
		expect(s.objectRecognitionConnection().credentialConfigured).toBe(false);
		const input = {
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-business-credential-unique",
		};
		await s.configureObjectRecognition(input);
		expect(s.objectRecognitionCredentials()?.credential).toBe(input.credential);
		expect(JSON.stringify(s.objectRecognitionConnection())).not.toContain(
			input.credential,
		);
		const encrypted = store.read((db) =>
			db.query("SELECT credential FROM settings_object_recognition").get(),
		);
		expect(JSON.stringify(encrypted)).not.toContain(input.credential);
		expect(readStoredObjectRecognitionConnection(dbPath).configured).toBe(true);
		await expect(s.configureObjectRecognition(input)).rejects.toThrow(
			"revision_conflict",
		);
		await expect(
			s.configureObjectRecognition({
				expectedRevision: 1,
				baseUrl: "http://127.0.0.1:18796",
			}),
		).rejects.toThrow("invalid_object_recognition_credential_required");
		const wrong = await createSettings(store, {
			dbPath,
			env: { EUMENES_SECRET_KEY: Buffer.alloc(32, 42).toString("base64") },
		});
		expect(() => wrong.objectRecognitionCredentials()).toThrow(
			"secret_key_unavailable",
		);
		unlinkSync(join(dir, "keys", "settings.key"));
		const missing = await createSettings(store, { dbPath });
		expect(() => missing.objectRecognitionCredentials()).toThrow(
			"secret_key_unavailable",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LARM credential source is an explicit backend reference: no copied secret, no fallback, dedicated settings survive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-recognition-shared-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	const env = {
		LARM_API_TOKEN: "fixture-larm-long-term-credential",
		LARM_CONTROL_TOKEN: "fixture-larm-legacy-credential",
	};
	try {
		const s = await createSettings(store, { dbPath, env });
		await s.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-dedicated-credential",
		});
		const before = store.read((db) =>
			db.query("SELECT credential FROM settings_object_recognition").get(),
		);
		await s.configureObjectRecognition({
			expectedRevision: 1,
			credentialSource: "larm",
		});
		expect(s.objectRecognitionConnection()).toMatchObject({
			credentialSource: "larm",
			credentialConfigured: true,
			sharedCredentialAvailable: true,
		});
		expect(s.objectRecognitionCredentials()?.credential).toBe(
			env.LARM_API_TOKEN,
		);
		const firstVersion = s.objectRecognitionCredentials()?.credentialVersion;
		expect(
			store.read((db) =>
				db.query("SELECT credential FROM settings_object_recognition").get(),
			),
		).toEqual(before);
		expect(JSON.stringify(s.objectRecognitionConnection())).not.toContain(
			env.LARM_API_TOKEN,
		);
		expect(JSON.stringify(s.objectRecognitionConnection())).not.toContain(
			firstVersion!,
		);
		env.LARM_API_TOKEN = "fixture-larm-rotated-credential";
		expect(s.objectRecognitionCredentials()?.credentialVersion).not.toBe(
			firstVersion,
		);
		env.LARM_API_TOKEN = "";
		env.LARM_CONTROL_TOKEN = "";
		expect(s.objectRecognitionCredentials()).toBeNull();
		expect(s.objectRecognitionConnection().credentialConfigured).toBe(false);
		await expect(
			s.configureObjectRecognition({
				expectedRevision: 2,
				credentialSource: "larm",
			}),
		).rejects.toThrow("invalid_object_recognition_shared_credential");
		await s.configureObjectRecognition({
			expectedRevision: 2,
			credentialSource: "dedicated",
		});
		expect(s.objectRecognitionCredentials()?.credential).toBe(
			"fixture-dedicated-credential",
		);
		env.LARM_API_TOKEN = "fixture-larm-rotated-credential";
		await s.configureObjectRecognition({
			expectedRevision: 3,
			credentialSource: "larm",
			baseUrl: "http://127.0.0.1:18796",
		});
		// A dedicated credential bound to the old endpoint must not reach a new one.
		await expect(
			s.configureObjectRecognition({
				expectedRevision: 4,
				credentialSource: "dedicated",
			}),
		).rejects.toThrow("invalid_object_recognition_credential_required");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("existing settings migrate to dedicated mode; a new shared connection saves only the reference", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-recognition-migration-"));
	const dbPath = join(dir, "db");
	let store = openStore(
		dbPath,
		migrations.filter(
			(m) => m.id !== "settings/0005-object-recognition-credential-source",
		),
	);
	try {
		await store.write((db) => {
			db.query("INSERT INTO settings_object_recognition VALUES(1,1,?,?)").run(
				"http://127.0.0.1:18786",
				"opaque-existing-ciphertext",
			);
		});
		await store.close();
		store = openStore(dbPath, migrations);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT credential_source,credential FROM settings_object_recognition",
					)
					.get(),
			),
		).toEqual({
			credential_source: "dedicated",
			credential: "opaque-existing-ciphertext",
		});
		await store.write((db) => {
			db.query("DELETE FROM settings_object_recognition").run();
		});
		const s = await createSettings(store, {
			dbPath,
			env: { LARM_API_TOKEN: "fixture-shared-only-credential" },
		});
		await s.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credentialSource: "larm",
		});
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT credential_source,credential FROM settings_object_recognition",
					)
					.get(),
			),
		).toEqual({ credential_source: "larm", credential: "" });
		expect(readStoredObjectRecognitionConnection(dbPath).credentialSource).toBe(
			"larm",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
