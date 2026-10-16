import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createImageScreenAdapter,
	IMAGE_SCREEN_ADAPTER_REF,
} from "./image-screen-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";

test("image screen bundle seeds one registered screen and reads the image domain source", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(["image"]), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const entries = store.read((db) => caps.artifactsInTransaction(db));
		expect(
			entries.filter((entry) => entry.artifactId === "image.generation"),
		).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:image.generation@1",
				adapterRefs: [IMAGE_SCREEN_ADAPTER_REF],
				title: "画像生成",
			}),
		]);
		await caps.seed();
		expect(
			store
				.read((db) => caps.artifactsInTransaction(db))
				.filter((entry) => entry.artifactId === "image.generation"),
		).toHaveLength(1);
		const adapter = createImageScreenAdapter();
		expect(
			store.read((db) =>
				adapter.sourceInTransaction(db, "query:image-screen.list@1", undefined),
			),
		).toEqual({ revision: 0, data: { items: [] } });
		expect(
			store.read((db) =>
				adapter.sourceInTransaction(db, "query:image-screen.list@1", "other"),
			),
		).toBeNull();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
