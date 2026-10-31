import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createCapabilities } from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
const primary = JSON.parse(
	readFileSync(
		new URL(
			"../../domains/capabilities/bundles/settings.bundle.json",
			import.meta.url,
		),
		"utf8",
	),
);
import previous from "./fixtures/settings-live-v1.fixture.json";
import intermediate from "./fixtures/settings-live-v2.fixture.json";
const current = JSON.parse(
	readFileSync(
		new URL(
			"../../domains/capabilities/bundles/settings.live.bundle.json",
			import.meta.url,
		),
		"utf8",
	),
);
test("Live settings upgrade publishes the new selects and persistent save layout without changing the existing revision", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-live-upgrade-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store);
	const host = offlineBundleHost();
	try {
		for (const bundle of [primary, previous, intermediate]) {
			const result = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host),
			);
			expect(result.issues).toEqual([]);
		}
		const original = store.read((db) =>
			caps.documentInTransaction(db, "artifact:settings.live@1"),
		);
		expect(original).not.toBeNull();
		const second = store.read((db) =>
			caps.documentInTransaction(db, "artifact:settings.live@2"),
		);
		const result = await store.write((db) =>
			caps.importBundleInTransaction(db, current, host),
		);
		expect(result.issues).toEqual([]);
		expect(
			store.read((db) =>
				caps.documentInTransaction(db, "artifact:settings.live@2"),
			),
		).toEqual(second);
		expect(
			store.read((db) =>
				caps.documentInTransaction(db, "artifact:settings.live@1"),
			),
		).toEqual(original);
		expect(
			store
				.read((db) => caps.artifactsInTransaction(db))
				.some((a) => a.artifactRevisionId === "artifact:settings.live@4"),
		).toBe(true);
		expect(
			store.read((db) =>
				caps.documentInTransaction(db, "artifact:settings.live@3"),
			),
		).not.toBeNull();
		const replay = await store.write((db) =>
			caps.importBundleInTransaction(db, current, host),
		);
		expect(replay.issues).toEqual([]);
	} finally {
		caps.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
