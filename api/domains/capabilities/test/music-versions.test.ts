import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migration,
	musicBuiltins,
	musicPlan,
	musicPlanV2,
} from "..";
test("installed V1 music definitions survive the V2 upgrade and repeated seeding", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-music-versions-"));
	const store = openStore(join(dir, "db"), [migration]);
	const capabilities = createCapabilities(store, new Set(["music"]));
	try {
		await store.write((db) => {
			for (const definition of musicBuiltins.filter(
				(item) => item.revision === 1,
			))
				capabilities.registerBuiltinInTransaction(db, definition);
		});
		const before = store.read((db) =>
			db
				.query(
					"SELECT * FROM capability_revisions WHERE id='skill:music.create@1'",
				)
				.get(),
		);
		await capabilities.seed();
		await capabilities.seed();
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id='skill:music.create@1'",
					)
					.get(),
			),
		).toEqual(before);
		const prepared = await store.write((db) =>
			capabilities.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: "run", taskId: "task", cancelEpoch: 0 },
				"package:music.create@2",
				{ question: "歌声ありの曲" },
			),
		);
		expect(prepared.package.toolRevisionIds).toEqual(["tool:music.generate@2"]);
		expect(
			prepared.dependencies.find(
				(item) => item.revisionId === "skill:music.create@2",
			)?.body,
		).toContain("専用genderやvoice IDはありません");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("V1 keeps its schema while V2 enforces the verified integer duration and vocal fields", () => {
	const old = {
		title: "曲",
		description: "制作意図",
		prompt: "strings",
		durationSeconds: 30,
	};
	expect(musicPlan.parse(old)).toEqual(old);
	expect(musicPlanV2.safeParse(old).success).toBe(false);
	expect(
		musicPlanV2.parse({
			...old,
			instrumental: false,
			lyrics: "[Verse]\n朝",
			language: "ja",
		}).instrumental,
	).toBe(false);
	for (const seconds of [0, 0.5, 601])
		expect(
			musicPlanV2.safeParse({
				...old,
				durationSeconds: seconds,
				instrumental: true,
			}).success,
		).toBe(false);
});
