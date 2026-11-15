import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCapabilities, migrations } from "..";
import { openStore } from "../../../infrastructure/sqlite";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import bundle from "../bundles/web-note.bundle.json";

const legacy = {
	...bundle,
	definitions: bundle.definitions.filter((d) =>
		d.kind === "skill" ? d.revision < 3 : d.revision < 4,
	),
	bindings: bundle.bindings.filter((d) => d.revision === 1),
	schemas: bundle.schemas.filter((d) => d.revision === 1),
};

test("published web-note revisions stay immutable and the new output contract admits the existing byte budget", () => {
	expect(
		new Bun.CryptoHasher("sha256").update(JSON.stringify(legacy)).digest("hex"),
	).toBe("1665699e0d4edef6ee704fe2b4491c5a797ab92b17bdbd372fc92e06922ee7ee");
	expect(
		bundle.schemas.find((s) => s.id === "web.note.result" && s.revision === 2)!
			.schema.properties.answer!.maxLength,
	).toBe(64 * 1024);
});

for (const upgrade of [false, true]) {
	test(`web-note keeps one selectable entry on fresh seed and upgrade, with idempotent registration (upgrade=${upgrade})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-note-bundle-"));
		const store = openStore(join(dir, "db"), migrations);
		const caps = createCapabilities(store, new Set(["web-note"]), {
			bundleHost: offlineBundleHost,
		});
		try {
			if (upgrade)
				await store.write((db) =>
					caps.importBundleInTransaction(db, legacy, offlineBundleHost()),
				);
			const registered = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, offlineBundleHost()),
			);
			expect(registered.issues).toEqual([]);
			const repeated = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, offlineBundleHost()),
			);
			expect(repeated).toEqual({ issues: [], registered: [] });
			const active = store.read((db) => caps.toolchainsInTransaction(db));
			expect(active.map((d) => [d.revisionId, d.functionName])).toEqual([
				["toolchain:web.note@4", "web_note"],
			]);
			const set = store.read((db) =>
				caps.toolchainSetInTransaction(db, "toolchain:web.note@4"),
			);
			expect(set.skills).toHaveLength(1);
			expect(set.binding?.document).toMatchObject({
				revision: 2,
				adapterRef: "adapter:web-note@1",
				inputSchemaRef: "schema:web.note.request@1",
				outputSchemaRef: "schema:web.note.result@2",
			});
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
