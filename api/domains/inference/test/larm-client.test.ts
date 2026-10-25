import { expect, test } from "bun:test";
import type { Settings } from "../../settings";
import { stableLarmClient } from "../service/configured-larm";

const saved = (profile: string) =>
	({
		baseUrl: "http://127.0.0.1:9810",
		profile,
		audience: "saaa-desktop",
	}) as Settings["larm"];

test("the LARM client is stable for one installation and connection, and changes with them", () => {
	const key = new Uint8Array(32).fill(1);
	const client = stableLarmClient(key, saved("a"));
	expect(client).toMatch(/^eumenes-[0-9a-f]{32}$/);
	expect(stableLarmClient(new Uint8Array(32).fill(1), saved("a"))).toBe(client);
	expect(stableLarmClient(key, saved("b"))).not.toBe(client);
	expect(stableLarmClient(new Uint8Array(32).fill(2), saved("a"))).not.toBe(
		client,
	);
	// Without the settings key there is no stable identity: the port makes its own.
	expect(stableLarmClient(undefined, saved("a"))).toBeUndefined();
});

test("the host keeps a connection that the port of the new settings shares, and releases one it does not", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { openStore } = await import("../../../infrastructure/sqlite");
	const { createSettings } = await import("../../settings");
	const { createInference } = await import("..");
	const { migrations } = await import("../../../application/migrations");
	const dir = mkdtempSync(join(tmpdir(), "eumenes-larm-client-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, migrations);
	const settings = await createSettings(store, { dbPath, env: {} });
	const closes: Array<{ speed?: number; profile?: string; keep: boolean }> = [];
	const inference = createInference(store, settings, {
		keepLarmConnection: true,
		larmFactory: (s) =>
			({
				status: () => ({ state: "unconfigured", capabilities: [] }),
				close: async (options?: { keepConnection?: true }) => {
					closes.push({
						speed: s.larm.speed,
						profile: s.larm.profile,
						keep: !!options?.keepConnection,
					});
				},
			}) as never,
	});
	const change = async (larm: Partial<Settings["larm"]>) => {
		const current = settings.get();
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: current.revision,
			settings: { ...current, larm: { ...current.larm, ...larm } },
			keys: [],
		});
		inference.status();
	};
	try {
		await change({ baseUrl: "http://127.0.0.1:9810", profile: "a", speed: 1 });
		await change({ speed: 1.2 });
		await change({ profile: "b" });
		expect(closes).toEqual([
			// Only the voice changed: the same client keeps its connection and cache.
			{ speed: 1, profile: "a", keep: true },
			// The profile changed: the old connection is released.
			{ speed: 1.2, profile: "a", keep: false },
		]);
	} finally {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
