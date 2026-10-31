import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCapabilities,
	artifactDefinitionV1,
} from "../../domains/capabilities";
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
				artifactRevisionId: "artifact:image.generation@2",
				adapterRefs: [IMAGE_SCREEN_ADAPTER_REF],
				title: "画像生成",
			}),
		]);

		const artifact = store.read((db) =>
			artifactDefinitionV1.parse(
				caps.documentInTransaction(db, "artifact:image.generation@2")?.document,
			),
		);
		expect(artifact.variants[0]!.definition).toMatchObject({
			creationOptions: {
				defaults: { model: "qwen-image-2.1-turbo" },
				models: [
					{ value: "qwen-image-2.1-turbo", label: "Qwen Turbo（既定）" },
					{
						value: "flux-3-image-klein",
						label: "FLUX 3 Image Klein（準備中）",
					},
				],
			},
		});
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
