import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../infrastructure/sqlite";
import {
	createCapabilities,
	bundleFiles,
	capabilityBundleV1,
} from "../../domains/capabilities";
import { migrations } from "../migrations";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
const bundle = capabilityBundleV1.parse(
	bundleFiles().find((b) => b.name === "markdown.bundle.json")!.raw,
);

test("seeding upgrades the published editor without rewriting v1, and repeated seeding is stable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-markdown-registration-")),
		store = openStore(join(dir, "test.sqlite"), migrations);
	try {
		const capabilities = createCapabilities(
			store,
			new Set(["markdown", "task-execution"]),
			{ bundleHost: offlineBundleHost },
		);
		const artifact = structuredClone(bundle.artifacts[0]!);
		artifact.revision = 1;
		artifact.actionBindings = artifact.actionBindings.filter(
			(a) => a.actionId !== "reconcile",
		);
		for (const action of artifact.actionBindings)
			action.inputSchemaRef = action.inputSchemaRef.replace(/@2$/, "@1");
		const old = {
			formatVersion: 1,
			bundleId: "markdown-published-fixture",
			pins: [],
			definitions: [],
			artifacts: [artifact],
			schemas: bundle.schemas
				.filter((s) => s.revision <= 2)
				.map((s) => ({ ...s, revision: 1 })),
		};
		const imported = await store.write((db) =>
			capabilities.importBundleInTransaction(db, old, offlineBundleHost(), {}),
		);
		expect(imported.issues).toEqual([]);
		const before = store.read((db) =>
			capabilities.documentInTransaction(db, "artifact:markdown.workspace@1"),
		);
		expect(before).not.toBeNull();
		await capabilities.seed();
		await capabilities.seed();
		const after = store.read((db) =>
			capabilities.documentInTransaction(db, "artifact:markdown.workspace@1"),
		);
		expect(after).toEqual(before);
		expect(
			store
				.read((db) => capabilities.artifactsInTransaction(db))
				.filter((a) => a.artifactId === "markdown.workspace")
				.map((a) => a.artifactRevisionId),
		).toEqual(["artifact:markdown.workspace@4"]);
		expect(
			store
				.read((db) => capabilities.toolchainsInTransaction(db))
				.find((t) => t.id === "markdown.collaborate"),
		).toMatchObject({
			revisionId: "toolchain:markdown.collaborate@4",
			bindingRevisionId: "binding:markdown.collaborate@4",
			artifactRevisionId: "artifact:markdown.workspace@4",
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
