import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createSettings, epochsMigration, migration } from "..";
import type { Settings } from "../contracts";

export const cleanup: Array<() => Promise<void>> = [];
export async function setup() {
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
export function cloud(s: Settings) {
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
export function credentialRows(h: Awaited<ReturnType<typeof setup>>) {
	return h.store.read(
		(db) =>
			db.query("SELECT id, encrypted FROM settings_credentials").all() as {
				id: string;
				encrypted: string;
			}[],
	);
}
export function claude(
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
export const save = (
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
