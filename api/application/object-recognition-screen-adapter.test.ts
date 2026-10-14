import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createObjectRecognitionScreenAdapter,
	OBJECT_RECOGNITION_SCREEN_ADAPTER_REF,
} from "./object-recognition-screen-adapter";
import { offlineBundleHost } from "./toolchain-adapters";

test("recognition screen seeds once and exposes its owner-scoped source", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-recognition-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(["object-recognition"]), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const entries = store.read((db) => caps.artifactsInTransaction(db));
		expect(
			entries.filter(
				(entry) => entry.artifactId === "object-recognition.workspace",
			),
		).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:object-recognition.workspace@1",
				adapterRefs: [OBJECT_RECOGNITION_SCREEN_ADAPTER_REF],
				title: "映っている物を調べる",
			}),
		]);
		await caps.seed();
		expect(
			store
				.read((db) => caps.artifactsInTransaction(db))
				.filter((entry) => entry.artifactId === "object-recognition.workspace"),
		).toHaveLength(1);
		const adapter = createObjectRecognitionScreenAdapter();
		expect(
			store.read((db) =>
				adapter.sourceInTransaction(
					db,
					"query:object-recognition-screen.list@1",
					undefined,
				),
			),
		).toEqual({ revision: 0, data: { items: [] } });
		expect(
			store.read((db) =>
				adapter.sourceInTransaction(
					db,
					"query:object-recognition-screen.list@1",
					"other",
				),
			),
		).toBeNull();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
