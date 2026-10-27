import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { bundleFiles, createCapabilities } from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
type Addition = {
	artifacts: { actionBindings: { eventAction: string }[] }[];
	definitions: { id: string }[];
};
const bundleRaw = (name: string) =>
	bundleFiles().find((f) => f.name === `${name}.bundle.json`)!.raw;
const ocrOriginal = bundleRaw("ocr");
const recognitionOriginal = bundleRaw("object-recognition-screen");
const ocrAddition = bundleRaw("ocr.visual-analysis") as Addition;
const recognitionAddition = bundleRaw(
	"object-recognition-screen.visual-analysis",
) as Addition;
test("existing OCR and recognition artifacts upgrade without replacing published revisions or adding a toolchain identity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "visual-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(
		store,
		new Set(["ocr", "object-recognition"]),
		{ bundleHost: offlineBundleHost },
	);
	try {
		const host = offlineBundleHost();
		for (const bundle of [ocrOriginal, recognitionOriginal])
			expect(
				(
					await store.write((db) =>
						caps.importBundleInTransaction(db, bundle, host),
					)
				).issues,
			).toEqual([]);
		for (const bundle of [ocrAddition, recognitionAddition]) {
			const result = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host),
			);
			expect(result.issues).toEqual([]);
			expect(result.registered.length).toBeGreaterThan(0);
			expect(
				await store.write((db) =>
					caps.importBundleInTransaction(db, bundle, host),
				),
			).toEqual({ issues: [], registered: [] });
		}
		// The originals remain accepted byte for byte after the upgrade.
		for (const bundle of [ocrOriginal, recognitionOriginal])
			expect(
				await store.write((db) =>
					caps.importBundleInTransaction(db, bundle, host),
				),
			).toEqual({ issues: [], registered: [] });
		const entries = store.read((db) => caps.artifactsInTransaction(db));
		expect(
			entries.find((e) => e.artifactId === "ocr.workspace")?.artifactRevisionId,
		).toBe("artifact:ocr.workspace@6");
		expect(
			entries.find((e) => e.artifactId === "object-recognition.workspace")
				?.artifactRevisionId,
		).toBe("artifact:object-recognition.workspace@4");
		for (const artifact of [
			...ocrAddition.artifacts,
			...recognitionAddition.artifacts,
		])
			expect(
				artifact.actionBindings
					.filter((a) => a.eventAction.startsWith("analysis-"))
					.map((a) => a.eventAction),
			).toEqual([
				"analysis-open",
				"analysis-run",
				"analysis-cancel",
				"analysis-select",
			]);
		expect(ocrAddition.definitions.map((d) => d.id)).toEqual(["ocr.manage"]);
		expect(recognitionAddition.definitions).toEqual([]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
