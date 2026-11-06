import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertInteractSchema } from "eumenes-interact/sqlite";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
test("package migrations follow the existing browser tail and upgrade an old database without rewriting applied SQL", async () => {
	const first = migrations.find((m) => m.id === "interact-package/0001")!;
	expect(first.after).toContain("browser/0006-replays");
	expect(first.after?.some((id) => id.includes("undefined"))).toBe(false);
	const dir = mkdtempSync(join(tmpdir(), "interact-migrate-"));
	const path = join(dir, "db");
	let store = openStore(
		path,
		migrations.filter(
			(m) =>
				!m.id.startsWith("interact-package/") &&
				// The browser domain's own interact tables, and what was added on top of them later (0008).
				!/^browser\/\d{4}-interact/.test(m.id),
		),
	);
	try {
		await store.write((db) =>
			db
				.query("INSERT INTO browser_settings VALUES('existing','kept',1)")
				.run(),
		);
		await store.close();
		store = openStore(path, migrations);
		store.read((db) => {
			assertInteractSchema(db);
			expect(
				db
					.query("SELECT value FROM browser_settings WHERE key='existing'")
					.get(),
			).toEqual({ value: "kept" });
			expect(
				db.query("SELECT COUNT(*) AS n FROM browser_interact_runs").get(),
			).toEqual({ n: 0 });
		});
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM schema_migrations_v2 WHERE id LIKE 'interact-package/%'",
					)
					.get(),
			),
		).toEqual({ n: 2 });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
