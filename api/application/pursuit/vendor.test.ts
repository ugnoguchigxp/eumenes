import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createPursuitEngine } from "eumenes-pursuit";
import {
	migrations,
	forgetPursuit,
	findPursuitByOperation,
} from "eumenes-pursuit/sqlite";
import { openStore } from "../../infrastructure/sqlite";
import { migrations as applicationMigrations } from "../migrations";
const root = join(import.meta.dir, "../../..");
test("Pursuit package, manifest, lock and public lifecycle contracts agree", () => {
	const manifest = JSON.parse(
		readFileSync(join(root, "vendor/pursuit/manifest.json"), "utf8"),
	);
	const archive = readFileSync(
		join(root, `vendor/pursuit/${manifest.artifact}`),
	);
	expect(createHash("sha256").update(archive).digest("hex")).toBe(
		manifest.sha256,
	);
	expect(
		JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies[
			manifest.package
		],
	).toBe(`file:vendor/pursuit/${manifest.artifact}`);
	expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain(
		`eumenes-pursuit@vendor/pursuit/${manifest.artifact}`,
	);
	expect(migrations).toHaveLength(manifest.dbSchemaVersion);
	for (const m of migrations)
		expect(createHash("sha256").update(m.sql).digest("hex")).toBe(m.sha256);
	expect(typeof createPursuitEngine).toBe("function");
	expect(typeof forgetPursuit).toBe("function");
	expect(typeof findPursuitByOperation).toBe("function");
});

test("Eumenes upgrades an existing schema 8 pursuit database through its migration runner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pursuit-vendor-upgrade-"));
	const path = join(dir, "db");
	const added = ["pursuit-core/0009", "pursuit-core/0010"];
	try {
		const old = openStore(
			path,
			applicationMigrations.filter((m) => !added.includes(m.id)),
		);
		try {
			await old.write((db) =>
				db
					.query(
						"INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at) VALUES ('existing','conversation','cancelled',0,0,0,1,NULL,0,0)",
					)
					.run(),
			);
		} finally {
			await old.close();
		}
		const upgraded = openStore(path, applicationMigrations);
		try {
			upgraded.readSnapshot((db) => {
				expect(
					db
						.query(
							"SELECT id FROM schema_migrations_v2 WHERE id IN (?,?) ORDER BY id",
						)
						.all(...added),
				).toEqual(added.map((id) => ({ id })));
				expect(
					db.query("SELECT state FROM pursuit_runs WHERE id='existing'").get(),
				).toEqual({ state: "cancelled" });
				expect(
					db.query("SELECT count(*) AS n FROM pursuit_progress").get(),
				).toEqual({ n: 0 });
			});
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
