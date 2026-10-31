import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, toolchainBuiltins, zSchema } from "..";
test("image seed is additive, repeatable and published with one flat request schema", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-seed-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const old = createCapabilities(store, new Set(["music"]));
		await old.seed();
		const before = store.read((db) =>
			db
				.query(
					"SELECT * FROM capability_revisions WHERE id='package:music.create@2'",
				)
				.get(),
		);
		const c = createCapabilities(store, new Set(["music", "image"]));
		await c.seed();
		await c.seed();
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id='package:music.create@2'",
					)
					.get(),
			),
		).toEqual(before);
		const p = await store.write((db) =>
			c.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: "run", taskId: "task", cancelEpoch: 0 },
				"package:image.create@1",
				{ question: "描いて" },
			),
		);
		expect(p.package.toolRevisionIds).toEqual(["tool:image.generate@1"]);
		const d = toolchainBuiltins.find((d) => d.id === "image.create")!;
		expect(d.functionName).toBe("image");
		expect(d.dependencies).toEqual(["package:image.create@1"]);
		expect(zSchema("imagePlan").type).toBe("object");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("image model-selection bundle upgrades legacy definitions without rewriting their revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-image-models-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		await createCapabilities(store, new Set(["image"])).seed();
		const legacy = () =>
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id IN ('package:image.create@1','skill:image.create@1','tool:image.generate@1') ORDER BY id",
					)
					.all(),
			);
		const before = legacy();
		const c = createCapabilities(store, new Set(["image"]), {
			bundleHost: () => ({
				adapters: new Map(),
				availability: new Set(),
				inputAdapters: new Set(),
				projections: new Set(),
				domainSchemas: new Set(),
			}),
		});
		await c.seed();
		await c.seed();
		expect(legacy()).toEqual(before);
		const p = store.read((db) =>
			c.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: "run", taskId: "task", cancelEpoch: 0 },
				"package:image.create@2",
				{ question: "描いて" },
			),
		);
		expect(p.package.toolRevisionIds).toEqual(["tool:image.generate@2"]);
		expect(p.dependencies.find((d) => d.kind === "skill")?.body).toContain(
			"modelを省略",
		);
		expect(zSchema("imagePlanV2").type).toBe("object");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
