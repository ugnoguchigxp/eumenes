import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, type BundleHost } from "..";

test("new Web revisions upgrade and reseed without changing archived definitions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-bundle-"));
	const store = openStore(join(dir, "db"), migrations);
	const host = (): BundleHost => ({
		adapters: new Map(),
		availability: new Set(),
		inputAdapters: new Set(),
		projections: new Set(),
		domainSchemas: new Set(),
		connections: new Set(),
	});
	try {
		await createCapabilities(store, new Set(["web"])).seed();
		const archived = () =>
			store.read((db) =>
				db
					.query(
						"SELECT id,definition_hash FROM capability_revisions WHERE id IN ('package:web.recipe@1','package:web.search@1','package:web.quick@2','profile:web.research@1','skill:web.search@1','tool:web.read@1') ORDER BY id",
					)
					.all(),
			);
		const before = archived();
		const caps = createCapabilities(store, new Set(["web"]), {
			bundleHost: host,
		});
		await caps.seed();
		expect(archived()).toEqual(before);
		const active = () =>
			store.read((db) =>
				db
					.query(
						"SELECT key,active_revision_id FROM capability_items WHERE key IN ('toolchain:web.search','toolchain:web.research.luna','package:web.quick') ORDER BY key",
					)
					.all(),
			);
		expect(active()).toEqual([
			{ key: "package:web.quick", active_revision_id: "package:web.quick@3" },
			{
				key: "toolchain:web.research.luna",
				active_revision_id: "toolchain:web.research.luna@2",
			},
			{
				key: "toolchain:web.search",
				active_revision_id: "toolchain:web.search@2",
			},
		]);
		const registered = active();
		await caps.seed();
		expect(active()).toEqual(registered);
		expect(archived()).toEqual(before);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
