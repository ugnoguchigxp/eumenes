import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, zSchema, type BundleHost } from "..";
import { builtins } from "../builtin/web-research";

test("deployed search schemas survive upgrade; current packages use the new tool revision and reseed safely", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lookup-upgrade-"));
	const store = openStore(join(dir, "db"), migrations);
	const host: BundleHost = {
		adapters: new Map(),
		availability: new Set(),
		inputAdapters: new Set(),
		projections: new Set(),
		domainSchemas: new Set(),
		connections: new Set(),
	};
	const old = createCapabilities(store, new Set(["web"]));
	const current = createCapabilities(store, new Set(["web"]), {
		bundleHost: () => host,
	});
	try {
		await store.write((db) => {
			for (const d of builtins.filter(
				(d) =>
					!(d.kind === "tool" && d.id === "web.lookup" && d.revision === 2),
			))
				old.registerBuiltinInTransaction(db, d);
		});
		const archived = () =>
			store.read((db) =>
				db
					.query(
						"SELECT definition_json, definition_hash FROM capability_revisions WHERE id='tool:web.lookup@1'",
					)
					.get(),
			);
		const before = archived();
		expect(zSchema("lookup").properties!.region).toMatchObject({
			description: "ISO region. Use JP with ja, US with en.",
		});
		expect(zSchema("lookupV2").properties!.region).toMatchObject({
			description:
				"検索対象の国・地域をISO 3166-1 alpha-2で指定する。検索言語とは独立に選ぶ。",
		});
		await current.seed();
		expect(archived()).toEqual(before);
		store.read((db) => {
			const prepared = current.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: "run", taskId: "task", cancelEpoch: 0 },
				"package:web.search@2",
				{ question: "公開情報を確認する" },
			);
			expect(
				prepared.dependencies.some(
					(d) =>
						d.revisionId === "tool:web.lookup@2" && d.schemaKey === "lookupV2",
				),
			).toBe(true);
			current.validateInTransaction(db, prepared);
		});
		await current.seed();
		expect(archived()).toEqual(before);
	} finally {
		old.close();
		current.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
