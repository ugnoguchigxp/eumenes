import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createCapabilities,
	capabilityBundleV1,
} from "../domains/capabilities";
import { withHarness } from "../domains/world/test/fixture";
import { migrations } from "./migrations";
import { offlineBundleHost } from "./toolchain-adapters";
import { worldDocuments } from "../domains/capabilities/contracts/world-query";
import { worldDocumentsInput } from "../domains/world/contracts/documents";
import { z } from "zod";

test("World document tool has the same public and owner contract", () => {
	expect(z.toJSONSchema(worldDocuments)).toEqual(
		z.toJSONSchema(worldDocumentsInput),
	);
});
test("World bundle upgrades an existing catalog without modifying old definitions and reseeds idempotently", async () => {
	await withHarness(
		async (h) => {
			const bundle = capabilityBundleV1.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../domains/capabilities/bundles/world-query.bundle.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			);
			const old = { ...bundle, definitions: bundle.definitions.slice(0, 6) };
			const caps = createCapabilities(h.store, new Set(["world-query"]), {
				bundleHost: offlineBundleHost,
			});
			await h.store.write((db) => {
				expect(
					caps.importBundleInTransaction(db, old, offlineBundleHost()).issues,
				).toEqual([]);
			});
			const archived = () =>
				h.store.read((db) =>
					db
						.query(
							"SELECT * FROM capability_revisions WHERE id IN ('profile:world.query@2','skill:world.query@4','package:world.query@4','toolchain:world.query@6') ORDER BY id",
						)
						.all(),
				);
			const before = archived();
			expect(before).toHaveLength(4);
			await caps.seed();
			expect(archived()).toEqual(before);
			await h.store.write((db) =>
				expect(
					caps.importBundleInTransaction(db, bundle, offlineBundleHost(), {
						dryRun: true,
					}),
				).toMatchObject({ issues: [], registered: [] }),
			);
			await caps.seed();
			expect(archived()).toEqual(before);
			expect(
				h.store.read(
					(db) =>
						caps.toolchainsInTransaction(db).find((t) => t.id === "world.query")
							?.revisionId,
				),
			).toBe("toolchain:world.query@7");
		},
		{},
		{ migrations },
	);
});
