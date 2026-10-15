import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, migration, epochsMigration } from "..";
import { settingsSchema, isAgentConnection } from "../contracts";

test("Workers AI keeps a shared encrypted token and account; changing the account revokes captured inference", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workers-settings-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, [migration, epochsMigration]);
	try {
		const settings = await createSettings(store, { dbPath, env: {} });
		const current = settings.get();
		const id = crypto.randomUUID();
		current.connections.push({
			id,
			name: "Workers音声",
			kind: "cloudflare-workers-ai",
			baseUrl: "https://api.cloudflare.com/client/v4",
			accountId: "a".repeat(32),
			epoch: 0,
			enabled: true,
			envRef: null,
		});
		for (const purpose of ["asr", "tts"] as const) {
			const resourceId = crypto.randomUUID();
			current.resources.push({
				id: resourceId,
				connectionId: id,
				purpose,
				model: `@cf/fixture/${crypto.randomUUID()}`,
				contextWindow: null,
				voice: null,
				language: "ja",
			});
			current.routes[purpose] = {
				...current.routes[purpose],
				mode: "cloud-only",
				fallbackId: resourceId,
				cloudAllowed: true,
			};
		}
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: current.revision,
			settings: current,
			keys: [{ connectionId: id, value: "fixture-private-token" }],
		});
		const captured = settings.get(),
			connection = captured.connections[0]!;
		expect(isAgentConnection(connection)).toBe(false);
		expect(settings.credential(connection)).toBe("fixture-private-token");
		expect(JSON.stringify(captured)).not.toContain("fixture-private-token");
		expect(
			JSON.stringify(
				store.read((db) =>
					db.query("SELECT encrypted FROM settings_credentials").get(),
				),
			),
		).not.toContain("fixture-private-token");
		const reopened = await createSettings(store, { dbPath, env: {} });
		expect(reopened.get().connections[0]?.accountId).toBe("a".repeat(32));
		expect(reopened.get().resources.map((r) => r.language)).toEqual([
			"ja",
			"ja",
		]);
		const next = settings.get();
		next.connections[0]!.accountId = "b".repeat(32);
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: next.revision,
			settings: next,
			keys: [],
		});
		expect(settings.get().connections[0]!.epoch).toBeGreaterThan(
			connection.epoch,
		);
		expect(
			store.read((db) => settings.valid(db, captured, "asr", connection)),
		).toBe(false);
		expect(
			store.read((db) => settings.valid(db, captured, "tts", connection)),
		).toBe(false);
		expect(settings.credential(settings.get().connections[0]!)).toBe(
			"fixture-private-token",
		);
		for (const invalid of ["invalid", undefined]) {
			const s = settings.get();
			s.connections[0]!.accountId = invalid;
			expect(settingsSchema.safeParse(s).success).toBe(false);
		}
		const s = settings.get();
		s.connections[0]!.baseUrl = "https://untrusted.example";
		expect(settingsSchema.safeParse(s).success).toBe(false);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
