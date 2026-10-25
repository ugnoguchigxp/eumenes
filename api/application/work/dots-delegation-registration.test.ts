import { expect, test } from "bun:test";
import { delegationFixture } from "./dots-delegation.fixture";
import legacy from "./dots-legacy-toolchain.fixture.json";
import { readFileSync } from "node:fs";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import {
	capabilityBundleV1,
	type Definition,
} from "../../domains/capabilities";
const currentBundle = capabilityBundleV1.parse(
	JSON.parse(
		readFileSync(
			new URL(
				"../../domains/capabilities/bundles/dots-delegation.bundle.json",
				import.meta.url,
			),
			"utf8",
		),
	),
);
test("stored first document revisions survive upgrade and do not block the current bundle", async () => {
	const f = await delegationFixture();
	try {
		const prior = structuredClone(currentBundle);
		prior.definitions = [];
		prior.bindings = [];
		prior.schemas = [];
		prior.artifacts = prior.artifacts.filter((a) => a.id === "settings.dots");
		prior.artifacts[0]!.revision = 2;
		prior.artifacts[0]!.title = "保存済みの旧設定";
		await f.store.write((db) =>
			f.caps.importBundleInTransaction(db, prior, offlineBundleHost()),
		);
		const old = f.store.readSnapshot((db) =>
			f.caps.documentInTransaction(db, "artifact:settings.dots@2"),
		);
		expect(old).not.toBeNull();
		expect(
			f.store.readSnapshot((db) =>
				f.caps.toolchainSetInTransaction(db, "toolchain:dots.delegate@5"),
			).binding?.revisionId,
		).toBe("binding:dots.delegate@3");
		await f.caps.seed();
		expect(
			f.store.readSnapshot((db) =>
				f.caps.documentInTransaction(db, "artifact:settings.dots@2"),
			),
		).toEqual(old);
	} finally {
		await f.close();
	}
});
test("fresh seed registers one launcher and immutable revisions; reseed keeps disabled publication", async () => {
	const f = await delegationFixture();
	try {
		const read = () =>
			f.store.readSnapshot((db) =>
				f.caps.toolchainSetInTransaction(db, "toolchain:dots.delegate@5"),
			);
		expect(read().binding?.revisionId).toBe("binding:dots.delegate@3");
		expect(read().package.revisionId).toBe("package:dots.request@2");
		expect(
			f.store.readSnapshot((db) =>
				f.caps
					.artifactsInTransaction(db)
					.filter((a) => a.artifactId === "dots.workspace"),
			),
		).toHaveLength(1);
		const old = f.store.readSnapshot((db) =>
			f.caps.getDefinitionInTransaction(db, "skill:dots.orchestrate@2"),
		);
		await f.store.write((db) =>
			f.caps.setEnabledInTransaction(db, "toolchain", "dots.delegate", false),
		);
		await f.caps.seed();
		expect(
			f.store.readSnapshot((db) =>
				f.caps.getDefinitionInTransaction(db, "skill:dots.orchestrate@2"),
			),
		).toEqual(old);
		expect(
			f.store.readSnapshot((db) =>
				f.caps
					.artifactsInTransaction(db)
					.filter((a) => a.toolchainId === "dots.delegate"),
			),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
});
test("an old seeded revision retains its hash while publication migrates to the new binding", async () => {
	const f = await delegationFixture(Date.now, legacy as Definition);
	try {
		expect(f.legacyBefore).not.toBeNull();
		expect(
			f.store.readSnapshot((db) =>
				f.caps.getDefinitionInTransaction(db, "toolchain:dots.delegate@1"),
			),
		).toEqual(f.legacyBefore);
		expect(
			f.store.readSnapshot((db) =>
				f.caps.toolchainSetInTransaction(db, "toolchain:dots.delegate@5"),
			).binding?.revisionId,
		).toBe("binding:dots.delegate@3");
		await f.caps.seed();
		expect(
			f.store.readSnapshot((db) =>
				f.caps.getDefinitionInTransaction(db, "toolchain:dots.delegate@1"),
			),
		).toEqual(f.legacyBefore);
	} finally {
		await f.close();
	}
});
