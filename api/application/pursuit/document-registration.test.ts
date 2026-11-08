import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createCapabilities,
	bundleFiles,
	capabilityBundleV1,
} from "../../domains/capabilities";
import { migrations } from "../migrations";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { describePursuitAdapter } from "./pursuit-adapter";

test("old research revisions remain intact while fresh and previously seeded databases publish document-capable research", async () => {
	const bundle = capabilityBundleV1.parse(
		bundleFiles().find((b) => b.name === "pursuit-research.bundle.json")!.raw,
	);
	const old = {
		...bundle,
		bundleId: "research-legacy-fixture",
		definitions: bundle.definitions.filter(
			(d) =>
				typeof d.kind === "string" &&
				typeof d.revision === "number" &&
				!(d.kind === "toolchain" && d.revision > 6) &&
				!(["skill", "package"].includes(d.kind) && d.revision > 4),
		),
		bindings: bundle.bindings.filter((b) => b.revision <= 3),
		schemas: bundle.schemas.filter((s) => s.revision <= 3),
	};
	for (const previouslySeeded of [false, true]) {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-research-registration-")),
			store = openStore(join(dir, "db"), migrations);
		try {
			const caps = createCapabilities(store, new Set(["pursuit"]), {
				bundleHost: offlineBundleHost,
			});
			if (previouslySeeded) {
				const result = await store.write((db) =>
					caps.importBundleInTransaction(db, old, offlineBundleHost(), {}),
				);
				expect(result.issues).toEqual([]);
			}
			const legacyBefore = previouslySeeded
				? store.read((db) =>
						caps.documentInTransaction(db, "binding:pursuit.research@2"),
					)
				: null;
			const priorInstructions = previouslySeeded
				? store.read((db) =>
						[
							"skill:pursuit.research@4",
							"package:pursuit.research@4",
							"toolchain:web.research@6",
						].map((id) => caps.documentInTransaction(db, id)),
					)
				: null;
			await caps.seed();
			const current = store.read((db) =>
				caps.toolchainsInTransaction(db).find((c) => c.id === "web.research"),
			);
			expect(current).toMatchObject({
				revisionId: "toolchain:web.research@7",
				bindingRevisionId: "binding:pursuit.research@3",
				minImpact: "create",
			});
			if (priorInstructions)
				expect(
					store.read((db) =>
						[
							"skill:pursuit.research@4",
							"package:pursuit.research@4",
							"toolchain:web.research@6",
						].map((id) => caps.documentInTransaction(db, id)),
					),
				).toEqual(priorInstructions);
			if (previouslySeeded)
				expect(
					store.read((db) =>
						caps.documentInTransaction(db, "binding:pursuit.research@2"),
					),
				).toEqual(legacyBefore);
			const before = store.read((db) =>
				caps.documentInTransaction(db, "binding:pursuit.research@3"),
			);
			await caps.seed();
			expect(
				store.read((db) =>
					caps.documentInTransaction(db, "binding:pursuit.research@3"),
				),
			).toEqual(before);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}
	expect(describePursuitAdapter(1).autonomy).toBe("read");
	expect(describePursuitAdapter(2).autonomy).toBe("create");
});
