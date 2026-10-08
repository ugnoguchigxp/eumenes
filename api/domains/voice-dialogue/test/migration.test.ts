import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../../dialogue";
import { createQueue, migration as queueMigration } from "../../queue";
import { migration as voiceMigration, sequenceMigration } from "..";
import { migration as schedulerMigration } from "../../scheduler";

test("a database with only the original three migrations (plus later ones) upgrades in place and keeps history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-mig-"));
	try {
		const file = join(dir, "db.sqlite3");
		const original = [conversationMigration, dialogueMigration, voiceMigration];
		const old = openStore(file, original);
		const now = new Date().toISOString();
		await old.write((db) => {
			for (const [i, text] of ["first", "second"].entries()) {
				db.query(
					"INSERT OR IGNORE INTO conversations (id, created_at) VALUES ('main', ?)",
				).run(now);
				db.query(
					"INSERT INTO messages (id,conversation_id,role,text,created_at,run_id) VALUES (?, 'main','user',?,?,?)",
				).run(`m${i}`, text, now, `r${i}`);
				db.query(
					"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,created_at,updated_at) VALUES (?,?,'main','completed',0,?,?,?)",
				).run(`r${i}`, `q${i}`, `m${i}`, now, now);
			}
		});
		await old.close();
		const upgraded = openStore(file, [
			...original,
			queueMigration,
			schedulerMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		const rows = upgraded.read((db) =>
			db
				.query(
					"SELECT id, seq, source_kind, job_id FROM dialogue_runs ORDER BY seq",
				)
				.all(),
		) as Array<{
			id: string;
			seq: number;
			source_kind: string;
			job_id: string | null;
		}>;
		expect(rows.map((r) => [r.id, r.source_kind, r.job_id])).toEqual([
			["r0", "manual", null],
			["r1", "manual", null],
		]);
		expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
		expect(
			createConversationService(upgraded).get("main").messages,
		).toHaveLength(2);
		const queue = createQueue(upgraded);
		const dialogue = createDialogueService(
			upgraded,
			createConversationService(upgraded),
			{
				status: () => ({ state: "ready", capabilities: [] }),
				connect: async () => {},
				answer: async () => "ok",
				transcribe: async () => "",
				speak: async () => new Uint8Array(),
				close: async () => {},
			},
			queue,
		);
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "third",
		});
		expect(
			upgraded.read(
				(db) =>
					(
						db
							.query("SELECT seq FROM dialogue_runs WHERE id=?")
							.get(run.id) as { seq: number }
					).seq,
			),
		).toBe(3);
		expect(
			upgraded.read((db) => db.query("SELECT id FROM schema_migrations").all()),
		).toHaveLength(7);
		await upgraded.close();
		// second start is a no-op
		const again = openStore(file, [
			...original,
			queueMigration,
			schedulerMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		expect(
			again.read((db) => db.query("SELECT id FROM schema_migrations").all()),
		).toHaveLength(7);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
