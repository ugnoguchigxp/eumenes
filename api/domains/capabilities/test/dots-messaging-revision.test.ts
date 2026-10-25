import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities, migrations } from "..";
import { openStore } from "../../../infrastructure/sqlite";
import { dotsBuiltins } from "../builtin/dots";
test("messaging v2 seeds without re-registering or replacing an installation's archived v1", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dots-revision-")),
		store = openStore(join(dir, "db"), migrations),
		caps = createCapabilities(store, new Set(["dots"]));
	try {
		const current = dotsBuiltins.find((d) => d.id === "dots.messaging")!;
		const archived = {
			...current,
			revision: 1,
			title: "保存済みの旧手順",
			body: "Archived installation instructions",
		};
		await store.write((db) => caps.registerBuiltinInTransaction(db, archived));
		const before = store.readSnapshot((db) =>
			caps.getDefinitionInTransaction(db, "skill:dots.messaging@1"),
		);
		await caps.seed();
		await caps.seed();
		expect(
			store.readSnapshot((db) =>
				caps.getDefinitionInTransaction(db, "skill:dots.messaging@1"),
			),
		).toEqual(before);
		expect(
			store.readSnapshot((db) =>
				caps.getDefinitionInTransaction(db, "skill:dots.messaging@2"),
			)?.body,
		).toContain("submit_message_reply");
	} finally {
		caps.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
