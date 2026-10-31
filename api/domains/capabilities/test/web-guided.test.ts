import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, type BundleHost } from "..";

test("the Web bundle seeds the current revisions and reseeding changes nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-bundle-"));
	const store = openStore(join(dir, "db"), migrations);
	const host = (): BundleHost => ({
		adapters: new Map(),
		availability: new Set(),
		inputAdapters: new Set(),
		projections: new Set(),
		domainSchemas: new Set(),
	});
	try {
		const caps = createCapabilities(store, new Set(["web"]), {
			bundleHost: host,
		});
		await caps.seed();
		const active = () =>
			store.read((db) =>
				db
					.query(
						"SELECT key,active_revision_id FROM capability_items WHERE key IN ('toolchain:web.search','package:web.quick') ORDER BY key",
					)
					.all(),
			);
		const stored = () =>
			store.read((db) =>
				db
					.query(
						"SELECT id,definition_hash FROM capability_revisions WHERE id IN ('profile:web.guided@1','skill:web.guided@5','package:web.recipe@6','package:web.search@6','package:web.quick@7','toolchain:web.search@8') ORDER BY id",
					)
					.all(),
			);
		expect(active()).toEqual([
			{ key: "package:web.quick", active_revision_id: "package:web.quick@7" },
			{
				key: "toolchain:web.search",
				active_revision_id: "toolchain:web.search@8",
			},
		]);
		const registered = stored();
		expect(registered).toHaveLength(6);
		await caps.seed();
		expect(active()).toEqual([
			{ key: "package:web.quick", active_revision_id: "package:web.quick@7" },
			{
				key: "toolchain:web.search",
				active_revision_id: "toolchain:web.search@8",
			},
		]);
		expect(stored()).toEqual(registered);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
