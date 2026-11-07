import { expect, test } from "bun:test";
import { createCapabilities, migrations, type BundleHost } from "..";
import { bindingInTransaction } from "../service/documents";
import { insertDocument } from "../repository";
import { openStore } from "../../../infrastructure/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bundle from "../bundles/pipeline-execution.bundle.json";
import { retainedDefinition } from "../repository";
const host: BundleHost = {
	adapters: new Map([
		[
			"adapter:pipelines@2",
			{ operations: new Map(), queries: new Set(), pipeline: true },
		],
	]),
	availability: new Set(["availability:pipelines@2"]),
	inputAdapters: new Set(),
	projections: new Set(),
	domainSchemas: new Set(),
};
test("seed installs p0-3 idempotently, preserves an old binding body, and refuses its execution contract", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pipeline-seed-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(), { bundleHost: () => host });
	const legacy = {
		kind: "binding",
		id: "pipeline.saved",
		revision: 1,
		execution: "pipeline",
		adapterRef: "adapter:pipelines@1",
		availabilityRef: "availability:pipelines@1",
		tools: [],
		timeLimits: { runMs: 1800000, turnMs: 900000, inferenceMs: 45000 },
		pipeline: { formatVersion: 1, id: "saved", inputs: [], steps: [] },
	};
	try {
		await store.write((db) =>
			insertDocument(db, {
				revisionId: "binding:pipeline.saved@1",
				kind: "binding",
				itemId: "pipeline.saved",
				revision: 1,
				digest: "historical",
				document: legacy,
				bundleId: "old",
				createdAtMs: 1,
			}),
		);
		await caps.seed();
		const first = store.read((db) =>
			bindingInTransaction(db, "binding:pipeline.execute@2"),
		);
		expect(first?.document).toMatchObject({
			execution: "pipeline",
			contractVersion: "p0-3",
			adapterRef: "adapter:pipelines@2",
		});
		expect(
			store.read((db) => bindingInTransaction(db, "binding:pipeline.saved@1")),
		).toBeNull();
		const counts = () =>
			store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM capability_documents").get(),
			);
		const before = counts();
		await caps.seed();
		expect(counts()).toEqual(before);
		expect(
			store.read((db) =>
				bindingInTransaction(db, "binding:pipeline.execute@2"),
			),
		).toEqual(first);
		expect(
			store.read((db) =>
				db
					.query("SELECT document_json FROM capability_documents WHERE id=?")
					.get("binding:pipeline.saved@1"),
			),
		).toEqual({ document_json: JSON.stringify(legacy) });
		expect(
			store.read((db) => caps.toolchainsInTransaction(db)).map((c) => c.id),
		).toContain("pipeline.execute");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("planner instruction upgrade preserves old revisions and selects the new skill once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pipeline-upgrade-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(), { bundleHost: () => host });
	try {
		const old = {
			...bundle,
			definitions: bundle.definitions.filter((d) => d.revision === 1),
		};
		await store.write((db) => caps.importBundleInTransaction(db, old, host));
		const previous = store.read((db) =>
			retainedDefinition(db, "skill:pipeline.execute@1"),
		);
		const upgraded = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle, host),
		);
		expect(upgraded.issues).toEqual([]);
		expect(upgraded.registered).toEqual([
			"skill:pipeline.execute@2",
			"package:pipeline.execute@2",
			"toolchain:pipeline.execute@2",
		]);
		expect(
			store.read((db) => retainedDefinition(db, "skill:pipeline.execute@1")),
		).toEqual(previous);
		expect(
			store
				.read((db) => caps.toolchainsInTransaction(db))
				.find((c) => c.id === "pipeline.execute")?.revisionId,
		).toBe("toolchain:pipeline.execute@2");
		const selected = store.read((db) =>
			caps.toolchainSetInTransaction(db, "toolchain:pipeline.execute@2"),
		);
		expect(selected.package.revisionId).toBe("package:pipeline.execute@2");
		expect(selected.package.requiredSkillRevisionIds).toEqual([
			"skill:pipeline.execute@2",
		]);
		expect(selected.skills).toEqual([
			bundle.definitions.find((d) => d.kind === "skill" && d.revision === 2)!
				.body!,
		]);
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
