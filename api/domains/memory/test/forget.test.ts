import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
} from "../../continuity";
import { createMemoryService, migration } from "..";

test("forget removes every version of a fact beyond the 1000-row listing cap, and never another principal's item", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-forget-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			avatarMotionMigration,
			answerDeliveryMigration,
			continuityMigration,
			migration,
			...memoryPackageMigrations,
		]);
		const conversation = createConversationService(store);
		const memory = createMemoryService(
			store,
			conversation,
			createContinuityService(store),
			{ journalPath: join(dir, "journal.jsonl") },
		);
		expect((await memory.recover()).healthy).toBe(true);
		await conversation.append({
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "私はコーヒーが好きです",
			createdAt: "2026-10-01T00:00:00Z",
			runId: null,
		});
		const first = await memory.remember({
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: "drink",
			text: "コーヒーが好き",
			polarity: "affirmed",
		});
		// Pad the fact with superseded versions straight into the package table.
		store.write((db) => {
			const row = db
				.query("SELECT * FROM memory_state_item WHERE item_id=?")
				.get(first.id) as Record<string, unknown>;
			for (let i = 0; i < 1100; i++) {
				db.query(
					`INSERT INTO memory_state_item(item_id,principal,scope_key,subject,kind,semantic_key,status,revision,value_text,polarity,origin,evidence_ordinal,created_seq,updated_seq)
					 VALUES(?,?,?,?,?,?,'superseded',1,?,?,?,0,?,?)`,
				).run(
					`state:${i.toString(16).padStart(64, "0")}`,
					row.principal as string,
					row.scope_key as string,
					row.subject as string,
					row.kind as string,
					row.semantic_key as string,
					`v${i}`,
					row.polarity as string,
					row.origin as string,
					-1 - i,
					-1 - i,
				);
			}
			db.query(
				`INSERT INTO memory_state_item(item_id,principal,scope_key,subject,kind,semantic_key,status,revision,value_text,polarity,origin,evidence_ordinal,created_seq,updated_seq)
				 VALUES(?,?,?,?,?,?,'active',1,'x','affirmed','user_confirmed',0,1,1)`,
			).run(
				`state:${"f".repeat(64)}`,
				"someone-else",
				row.scope_key as string,
				row.subject as string,
				row.kind as string,
				"drink2",
			);
		});
		await expect(memory.forget(`state:${"f".repeat(64)}`)).rejects.toThrow(
			"invalid_memory_item",
		);
		const oldest = `state:${(1099).toString(16).padStart(64, "0")}`;
		expect((await memory.forget(oldest)).completed).toBe(true);
		const left = store.read(
			(db) =>
				db
					.query(
						"SELECT count(*) AS n FROM memory_state_item WHERE semantic_key='drink' AND status!='forgotten'",
					)
					.get() as { n: number },
		);
		expect(left.n).toBe(0);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
