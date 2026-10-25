import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { createCapabilities, migrations } from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
test("startup seed registers the messaging launcher and its local actions with the production adapter descriptions", async () => {
	const directory = mkdtempSync(join(tmpdir(), "eumenes-dots-registration-")),
		store = openStore(join(directory, "db"), migrations),
		capabilities = createCapabilities(store, new Set(["dots"]), {
			bundleHost: offlineBundleHost,
		});
	try {
		await capabilities.seed();
		const item = store.readSnapshot((db) =>
			capabilities
				.artifactsInTransaction(db)
				.find((x) => x.artifactId === "dots.messaging"),
		);
		if (!item) throw new Error("fixture_messaging_launcher_missing");
		expect(item).toMatchObject({
			artifactRevisionId: "artifact:dots.messaging@1",
			adapterRefs: ["adapter:dots-messaging@1"],
		});
		const document = store.readSnapshot((db) =>
			capabilities.documentInTransaction(db, "artifact:dots.messaging@1"),
		);
		expect(document?.document).toMatchObject({
			actionBindings: expect.arrayContaining([
				expect.objectContaining({
					eventAction: "dots-message-cancel",
					inputSchemaRef: "schema:dots-message-cancel@1",
					effect: "local",
				}),
			]),
		});
		await capabilities.seed();
		expect(
			store.readSnapshot((db) =>
				capabilities
					.artifactsInTransaction(db)
					.filter((x) => x.artifactId === "dots.messaging"),
			),
		).toEqual([item]);
	} finally {
		capabilities.close();
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
