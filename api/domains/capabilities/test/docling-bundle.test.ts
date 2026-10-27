import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, type BundleHost } from "..";
import bundle from "../bundles/docling-desk.bundle.json" with { type: "json" };

const host = (): BundleHost => ({
	adapters: new Map([
		[
			"adapter:docling@1",
			{
				operations: new Map([
					["docling.prepare", { inputSchemaRef: "builtin:emptyInput" }],
				]),
				queries: new Set(["query:docling.launcher@1"]),
			},
		],
	]),
	availability: new Set(["availability:docling@1"]),
	inputAdapters: new Set(),
	projections: new Set(["projection:docling.prepared@1"]),
	domainSchemas: new Set(["domain:docling.prepared@1"]),
});

test.each([false, true])(
	"Docling menu revision seeds once and preserves earlier revisions (existing=%s)",
	async (existing) => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-docling-bundle-"));
		const store = openStore(join(dir, "db"), migrations);
		const caps = createCapabilities(store, new Set(["docling"]), {
			bundleHost: host,
		});
		const load = (raw: unknown) =>
			store.write((db) => caps.importBundleInTransaction(db, raw, host()));
		try {
			if (existing) {
				const old = {
					...bundle,
					definitions: bundle.definitions.filter((d) => d.revision === 1),
					bindings: bundle.bindings.filter((d) => d.revision === 1),
					artifacts: bundle.artifacts.filter((d) => d.revision === 1),
				};
				expect((await load(old)).issues).toEqual([]);
			}
			const oldArtifact = store.read((db) =>
				caps.documentInTransaction(db, "artifact:docling.workspace@1"),
			);
			expect((await load(bundle)).issues).toEqual([]);
			store.read((db) => {
				const menus = caps
					.artifactsInTransaction(db)
					.filter((a) => a.artifactId === "docling.workspace");
				expect(menus).toHaveLength(1);
				expect(menus[0]).toMatchObject({
					artifactRevisionId: "artifact:docling.workspace@2",
					title: "文章ナレッジベース管理",
				});
				if (existing)
					expect(
						caps.documentInTransaction(db, "artifact:docling.workspace@1"),
					).toEqual(oldArtifact);
				expect(
					caps.toolchainBindingInTransaction(db, "toolchain:docling.desk@2")
						?.binding.revisionId,
				).toBe("binding:docling.desk@2");
			});
			expect((await load(bundle)).registered).toEqual([]);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
