import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";

const dependency = { id: "dialogue/0001-init", sql: "SELECT 1" };

test("the applied first migration retains its deployed checksum", () => {
	expect(createHash("sha256").update(migrations[0]!.sql).digest("hex")).toBe(
		"7ca220812c5bb5ca7d2b03213a77e17969fd622e1eba8976c0369edf2573de92",
	);
});

test("upgrading an existing work preserves it and adds the start reference once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-collaboration-upgrade-"));
	const path = join(dir, "test.sqlite3");
	try {
		const previous = openStore(path, [dependency, migrations[0]!]);
		await previous.write((db) =>
			db.exec(`INSERT INTO collaboration_works
 (id, session_id, kind, title, document_json, last_answer_message_id, created_at, updated_at)
 VALUES ('w1', 's1', 'pipeline', 'kept', '{"request":"kept"}', 'answer1', 1, 2)`),
		);
		await previous.close();
		const upgraded = openStore(path, [dependency, ...migrations]);
		try {
			expect(
				upgraded.read((db) =>
					db
						.query(
							`SELECT title, document_json, last_answer_message_id,
 last_start_message_id, created_at, updated_at FROM collaboration_works WHERE id='w1'`,
						)
						.get(),
				),
			).toEqual({
				title: "kept",
				document_json: '{"request":"kept"}',
				last_answer_message_id: "answer1",
				last_start_message_id: null,
				created_at: 1,
				updated_at: 2,
			});
			await upgraded.write((db) =>
				db.exec(
					"UPDATE collaboration_works SET last_start_message_id='start1' WHERE id='w1'",
				),
			);
		} finally {
			await upgraded.close();
		}
		const restarted = openStore(path, [dependency, ...migrations]);
		try {
			expect(
				restarted.read((db) =>
					db
						.query(
							"SELECT last_start_message_id FROM collaboration_works WHERE id='w1'",
						)
						.get(),
				),
			).toEqual({ last_start_message_id: "start1" });
		} finally {
			await restarted.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
