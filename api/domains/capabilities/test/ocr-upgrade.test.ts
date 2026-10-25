import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, type BundleHost } from "..";
import bundle from "../bundles/ocr.bundle.json";
const host: BundleHost = {
	adapters: new Map([
		[
			"adapter:ocr@1",
			{
				operations: new Map([
					[
						"ocr.open",
						{ inputSchemaRef: "builtin:emptyInput", effect: "read" },
					],
					["ocr.read", { inputSchemaRef: "builtin:ocrTarget", effect: "read" }],
					[
						"ocr.cancel",
						{ inputSchemaRef: "builtin:ocrTarget", effect: "write" },
					],
				]),
				queries: new Set(["query:ocr.list@1"]),
			},
		],
	]),
	availability: new Set(["availability:ocr@1"]),
	inputAdapters: new Set(),
	projections: new Set(["projection:ocr-result@1"]),
	domainSchemas: new Set(["domain:ocr.receipt@1"]),
};
const legacy = () => ({
	...bundle,
	definitions: bundle.definitions.filter(
		(x) =>
			!(x.id === "ocr.correct" && x.revision >= 2) &&
			!(x.kind === "toolchain" && x.revision === 5),
	),
	bindings: bundle.bindings.filter((x) => x.revision < 5),
	artifacts: bundle.artifacts.filter((x) => x.revision < 5),
	schemas: bundle.schemas.filter(
		(x) => !["ocr-region", "ocr-qr-item"].includes(x.id),
	),
});
test("OCR preserves all published revisions and upgrades an existing registry idempotently", async () => {
	expect(
		createHash("sha256")
			.update(
				JSON.stringify({
					...bundle,
					definitions: bundle.definitions.filter(
						(x) => !(x.id === "ocr.correct" && x.revision === 3),
					),
				}),
			)
			.digest("hex"),
	).toBe("0b566e67007ec2ec7edfb56e06b68d29ed1be7faa7a5f6062a0bbd023d2b89eb");
	expect(
		createHash("sha256").update(JSON.stringify(legacy())).digest("hex"),
	).toBe("bac9769f61d8ed4af59d71d98eea14030255651910264755ecc5a670b137f13f");
	const dir = mkdtempSync(join(tmpdir(), "ocr-upgrade-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["ocr"]), {
		bundleHost: () => host,
	});
	try {
		const old = await store.write((db) =>
			caps.importBundleInTransaction(db, legacy(), host),
		);
		expect(old.issues).toEqual([]);
		const previous = await store.write((db) =>
			caps.importBundleInTransaction(
				db,
				{
					...bundle,
					definitions: bundle.definitions.filter(
						(x) => !(x.id === "ocr.correct" && x.revision === 3),
					),
				},
				host,
			),
		);
		expect(previous.issues).toEqual([]);
		const added = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle, host),
		);
		expect(added.issues).toEqual([]);
		expect(added.registered.length).toBeGreaterThan(0);
		expect(
			await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host),
			),
		).toEqual({ issues: [], registered: [] });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
