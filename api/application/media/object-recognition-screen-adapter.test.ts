import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFiles, createCapabilities } from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createObjectRecognitionScreenAdapter,
	OBJECT_RECOGNITION_SCREEN_ADAPTER_REF,
} from "./object-recognition-screen-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";

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
				artifactRevisionId: "artifact:object-recognition.workspace@4",
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

test("the published recognition screen binds every action the screen sends", () => {
	const { artifacts } = bundleFiles().find(
		(f) => f.name === "object-recognition-screen.visual-analysis.bundle.json",
	)!.raw as {
		artifacts: {
			revision: number;
			actionBindings: { eventAction: string }[];
		}[];
	};
	const latest = artifacts.reduce((a, b) => (b.revision > a.revision ? b : a));
	expect(latest.revision).toBe(4);
	// An action without a binding is refused by the host as unavailable.
	expect(latest.actionBindings.map((b) => b.eventAction)).toEqual(
		expect.arrayContaining([
			"recognition-library-refresh",
			"recognition-library-select",
			"recognition-save-recheck",
			"recognition-save-resume",
		]),
	);
});
