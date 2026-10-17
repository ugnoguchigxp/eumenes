import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	capabilityBundleV1,
	type BundleHost,
} from "..";

test("new Web revisions upgrade and reseed without changing archived definitions", async () => {
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
		await createCapabilities(store, new Set(["web"])).seed();
		const caps = createCapabilities(store, new Set(["web"]), {
			bundleHost: host,
		});
		const bundle = capabilityBundleV1.parse(
			JSON.parse(
				readFileSync(
					new URL("../bundles/web-guided.bundle.json", import.meta.url),
					"utf8",
				),
			),
		);
		const boundary = bundle.definitions.findIndex(
			(d) => d.kind === "skill" && d.id === "web.guided" && d.revision === 2,
		);
		expect(boundary).toBeGreaterThan(0);
		await store.write((db) =>
			caps.importBundleInTransaction(
				db,
				{ ...bundle, definitions: bundle.definitions.slice(0, boundary) },
				host(),
			),
		);
		const archived = () =>
			store.read((db) =>
				db
					.query(
						"SELECT id,definition_hash FROM capability_revisions WHERE id IN ('package:web.recipe@1','package:web.search@1','package:web.quick@2','profile:web.research@1','skill:web.search@1','tool:web.read@1','skill:web.guided@1','package:web.recipe@2','package:web.search@2','package:web.quick@3') ORDER BY id",
					)
					.all(),
			);
		const before = archived();
		await caps.seed();
		expect(archived()).toEqual(before);
		const active = () =>
			store.read((db) =>
				db
					.query(
						"SELECT key,active_revision_id FROM capability_items WHERE key IN ('toolchain:web.search','toolchain:web.research.codex','package:web.quick') ORDER BY key",
					)
					.all(),
			);
		expect(active()).toEqual([
			{ key: "package:web.quick", active_revision_id: "package:web.quick@6" },
			{
				key: "toolchain:web.research.codex",
				active_revision_id: "toolchain:web.research.codex@3",
			},
			{
				key: "toolchain:web.search",
				active_revision_id: "toolchain:web.search@6",
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
