import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as conversationMigrations } from "../../conversation";
import { migrations } from "../repository";

test("session provenance upgrades the deployed output-origin schema without changing its migration or data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "live-input-upgrade-"));
	const path = join(dir, "live.sqlite3");
	let store = openStore(path, [
		...conversationMigrations,
		...migrations.slice(0, 3),
	]);
	try {
		await store.write((db) =>
			db
				.query(
					"INSERT INTO live_voice_outputs(session_id,text,kind,origin_key,origin_input,origin_version) VALUES('saved-session','saved proposal','commentary','saved-origin','{}',3)",
				)
				.run(),
		);
		const before = store.read((db) =>
			db
				.query(
					"SELECT checksum FROM schema_migrations_v2 WHERE id='live-voice/0003-output-origins'",
				)
				.get(),
		);
		await store.close();
		store = openStore(path, [...conversationMigrations, ...migrations]);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT checksum FROM schema_migrations_v2 WHERE id='live-voice/0003-output-origins'",
					)
					.get(),
			),
		).toEqual(before);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT text,origin_key,origin_version FROM live_voice_outputs",
					)
					.get(),
			),
		).toEqual({
			text: "saved proposal",
			origin_key: "saved-origin",
			origin_version: 3,
		});
		expect(
			store
				.read(
					(db) =>
						db.query("PRAGMA table_info(live_voice_sessions)").all() as {
							name: string;
						}[],
				)
				.some((row) => row.name === "input_json"),
		).toBe(true);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT 1 FROM schema_migrations_v2 WHERE id='live-voice/0004-session-inputs'",
					)
					.get(),
			),
		).not.toBeNull();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
