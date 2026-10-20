import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, migrations } from "..";

test("Bridge credentials are encrypted, write-only, revision-bound and invalidated on changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-bridge-test-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	try {
		const s = await createSettings(store, { dbPath, env: {} });
		expect(s.browserBridge()).toEqual({
			revision: 0,
			enabled: false,
			configured: false,
			available: true,
		});
		const token = "fixture-bridge-credential";
		let changes = 0;
		s.onBrowserBridgeChange(async () => {
			changes++;
		});
		await s.configureBrowserBridge({
			expectedRevision: 0,
			enabled: true,
			token,
		});
		expect(s.browserBridgeCredential()).toBe(token);
		expect(JSON.stringify(s.browserBridge())).not.toContain(token);
		expect(JSON.stringify(s.diagnostics())).not.toContain(token);
		expect(
			JSON.stringify(
				store.read((db) =>
					db.query("SELECT * FROM settings_browser_bridge").all(),
				),
			),
		).not.toContain(token);
		await expect(
			s.configureBrowserBridge({ expectedRevision: 0, enabled: false }),
		).rejects.toThrow("conflict_browser_bridge");
		await s.configureBrowserBridge({ expectedRevision: 1, enabled: false });
		expect(s.browserBridgeCredential()).toBeNull();
		expect(s.browserBridge().configured).toBe(true);
		await s.configureBrowserBridge({
			expectedRevision: 2,
			enabled: false,
			clear: true,
		});
		expect(s.browserBridge().configured).toBe(false);
		expect(changes).toBe(3);
		await expect(
			s.configureBrowserBridge({ expectedRevision: 3, enabled: true }),
		).rejects.toThrow("invalid_browser_bridge_credential");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Bridge ciphertext participates in master-key validation and missing-key protection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-bridge-key-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	try {
		const s = await createSettings(store, { dbPath, env: {} });
		await s.configureBrowserBridge({
			expectedRevision: 0,
			enabled: true,
			token: "fixture-key-check",
		});
		const wrong = await createSettings(store, {
			dbPath,
			env: { EUMENES_SECRET_KEY: Buffer.alloc(32, 42).toString("base64") },
		});
		expect(wrong.browserBridge().available).toBe(false);
		expect(() => wrong.browserBridgeCredential()).toThrow(
			"secret_key_unavailable",
		);
		unlinkSync(join(dir, "keys", "settings.key"));
		const missing = await createSettings(store, { dbPath, env: {} });
		expect(missing.browserBridge().available).toBe(false);
		expect(() => missing.browserBridgeCredential()).toThrow(
			"secret_key_unavailable",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
