import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createMusicScreenAdapter,
	MUSIC_SCREEN_ADAPTER_REF,
} from "./music-screen-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";

test("music screen bundle seeds one registered screen and reads the music domain source", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-music-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(["music"]), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const entries = store.read((db) => caps.artifactsInTransaction(db));
		expect(
			entries.filter((entry) => entry.artifactId === "music.generation"),
		).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:music.generation@2",
				adapterRefs: [MUSIC_SCREEN_ADAPTER_REF],
				title: "楽曲生成",
			}),
		]);
		await caps.seed();
		expect(
			store
				.read((db) => caps.artifactsInTransaction(db))
				.filter((entry) => entry.artifactId === "music.generation"),
		).toHaveLength(1);
		const adapter = createMusicScreenAdapter();
		const source = store.read((db) =>
			adapter.sourceInTransaction(db, "query:music-screen.list@1", undefined),
		);
		expect(source).toEqual({ revision: 0, data: { items: [] } });
		expect(
			store.read((db) =>
				adapter.sourceInTransaction(db, "query:music-screen.list@1", "other"),
			),
		).toBeNull();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
