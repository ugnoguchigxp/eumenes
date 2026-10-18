import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { workersSettingsFixture } from "./workers-ai-settings.fixture";

test("Spatial display v10 upgrades v9 immutably and reimports idempotently", async () => {
	const h = await workersSettingsFixture();
	try {
		const bundle = JSON.parse(
			readFileSync(
				new URL(
					"../../domains/capabilities/bundles/settings.spatial.bundle.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const legacy = {
			...bundle,
			artifacts: bundle.artifacts.filter(
				(a: { revision: number }) => a.revision <= 9,
			),
		};
		await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, legacy, h.host()),
		);
		const before = h.store.read((db) =>
			h.caps.documentInTransaction(db, "artifact:settings.display@9"),
		);
		for (let i = 0; i < 2; i++) {
			const result = await h.store.write((db) =>
				h.caps.importBundleInTransaction(db, bundle, h.host()),
			);
			expect(result.issues).toEqual([]);
		}
		expect(
			h.store.read((db) =>
				h.caps.documentInTransaction(db, "artifact:settings.display@9"),
			),
		).toEqual(before);
		const active = h.store
			.read((db) => h.caps.artifactsInTransaction(db))
			.find((a) => a.artifactId === "settings.display");
		expect(active?.artifactRevisionId).toBe("artifact:settings.display@10");
		const latest = bundle.artifacts.at(-1),
			scatter = latest.fields.find(
				(f: { fieldId: string }) => f.fieldId === "spatial.scatter",
			);
		expect(scatter.max).toBe(500);
		expect(scatter.defaultValue).toBe("350");
		expect(
			latest.fields.some(
				(f: { fieldId: string }) => f.fieldId === "spatial.spin-speed",
			),
		).toBe(false);
	} finally {
		await h.close();
	}
});
