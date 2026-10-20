import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createSettings,
	migrations,
	registerSettings,
} from "../../domains/settings";
import { createApp } from "../app";

test("Bridge settings use authenticated write-only HTTP, no-store responses and revision conflicts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-bridge-http-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, migrations);
	try {
		const settings = await createSettings(store, { dbPath, env: {} });
		const app = createApp({
			token: "fixture-app-auth",
			origin: "http://localhost",
			modules: [{ mount: (a) => registerSettings(a, settings) }],
		});
		const path = "/api/settings/browser-bridge";
		const headers = {
			authorization: "Bearer fixture-app-auth",
			"content-type": "application/json",
		};
		const input = {
			expectedRevision: 0,
			enabled: true,
			token: "fixture-private-bridge-token",
		};
		expect(
			(await app.request(path, { method: "PUT", body: JSON.stringify(input) }))
				.status,
		).toBe(401);
		expect(settings.browserBridge().configured).toBe(false);
		const saved = await app.request(path, {
			method: "PUT",
			headers,
			body: JSON.stringify(input),
		});
		expect(saved.status).toBe(200);
		expect(saved.headers.get("cache-control")).toBe("no-store");
		expect(await saved.text()).not.toContain(input.token);
		const read = await app.request(path, { headers });
		expect(read.headers.get("cache-control")).toBe("no-store");
		expect(await read.text()).not.toContain(input.token);
		const stale = await app.request(path, {
			method: "PUT",
			headers,
			body: JSON.stringify(input),
		});
		expect(stale.status).toBe(409);
		const invalid = await app.request(path, {
			method: "PUT",
			headers,
			body: "{fixture-private-invalid-secret",
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain(
			"fixture-private-invalid-secret",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
