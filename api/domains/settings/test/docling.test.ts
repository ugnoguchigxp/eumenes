import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, migrations } from "..";

test("Docling stores only revisioned loopback entrances and resolves the existing backend credential", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-docling-settings-")),
		dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	const env = { LARM_API_TOKEN: "fixture-existing-larm-credential" };
	try {
		const settings = await createSettings(store, { dbPath, env });
		expect(settings.doclingCredentials()).toBeNull();
		const input = {
			expectedRevision: 0,
			gatewayUrl: "http://127.0.0.1:28765",
			publicOrigin: "http://localhost:28765",
		};
		await settings.configureDocling(input);
		expect(settings.doclingCredentials()?.credential).toBe(env.LARM_API_TOKEN);
		expect(JSON.stringify(settings.doclingConnection())).not.toContain(
			env.LARM_API_TOKEN,
		);
		expect(
			JSON.stringify(
				store.read((db) => db.query("SELECT * FROM settings_docling").get()),
			),
		).not.toContain(env.LARM_API_TOKEN);
		await expect(settings.configureDocling(input)).rejects.toThrow(
			"revision_conflict",
		);
		for (const publicOrigin of [
			"http://192.168.0.130:28765",
			"http://localhost:28766",
			"http://localhost:28765/docling/",
			"http://localhost:28765?ticket=secret",
			"http://user:secret@localhost:28765",
			"bad-url",
		]) {
			await expect(
				settings.configureDocling({
					...input,
					expectedRevision: 1,
					publicOrigin,
				}),
			).rejects.toThrow("invalid_docling_settings");
		}
		const reopened = await createSettings(store, { dbPath, env });
		expect(reopened.doclingConnection().revision).toBe(1);
		expect(reopened.doclingConnection().publicOrigin).toBe(input.publicOrigin);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
