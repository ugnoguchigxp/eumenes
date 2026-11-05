import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	interactMigrations,
	readyInteractCaptures,
} from "../repository/interact";

const dependency = {
	id: "interact-package/0002",
	sql: "CREATE TABLE interact_runs (run_id TEXT PRIMARY KEY)",
};

test("the applied interact migration retains its deployed checksum", () => {
	expect(
		createHash("sha256").update(interactMigrations[0]!.sql).digest("hex"),
	).toBe("ba95c2a8b750fd0809980309c17b582bf5ff90a14882f70808e1f62ccc0fbcb5");
});

test("capture upgrade preserves old files without inventing their missing metadata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-capture-upgrade-"));
	const path = join(dir, "test.sqlite3");
	try {
		const previous = openStore(path, [dependency, interactMigrations[0]!]);
		await previous.write((db) =>
			db.exec(`
INSERT INTO interact_runs VALUES ('r1');
INSERT INTO browser_interact_runs (run_id,owner,conversation_id,request_id,input_digest,created_at,expires_at)
 VALUES ('r1','owner','conversation','request','digest',1,1000);
INSERT INTO browser_interact_captures (id,run_id,file_ref,width,height,bytes,expires_at)
 VALUES ('old','r1','kept-file',1,2,3,1000);`),
		);
		await previous.close();
		const upgraded = openStore(path, [dependency, ...interactMigrations]);
		try {
			expect(
				upgraded.read((db) =>
					db
						.query(
							"SELECT file_ref, range, created_at FROM browser_interact_captures WHERE id='old'",
						)
						.get(),
				),
			).toEqual({ file_ref: "kept-file", range: null, created_at: null });
			expect(
				upgraded.read((db) => readyInteractCaptures(db, "owner", 10, 10)),
			).toEqual([]);
			await upgraded.write((db) =>
				db.exec(`INSERT INTO browser_interact_captures
 (id,run_id,file_ref,width,height,bytes,expires_at,range,created_at)
 VALUES ('new','r1','new-file',2,3,4,1000,'element',5)`),
			);
			expect(
				upgraded
					.read((db) => readyInteractCaptures(db, "owner", 10, 10))
					.map((item) => ({
						id: item.id,
						range: item.range,
						capturedAt: item.captured_at,
					})),
			).toEqual([{ id: "new", range: "element", capturedAt: 5 }]);
		} finally {
			await upgraded.close();
		}
		await openStore(path, [dependency, ...interactMigrations]).close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
