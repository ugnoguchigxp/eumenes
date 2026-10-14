import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService } from "..";
import { memoryTestMigrations, saveItem } from "./memory.fixture";

const input = (itemIds: string[]) => ({
	conversationId: "c1",
	itemIds,
	messageIds: [] as string[],
});

test("forget removes every version of a fact beyond the 1000-row listing cap, and never another principal's item", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-forget-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), memoryTestMigrations);
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
		const first = await saveItem(store, memory, {
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: "drink",
			text: "コーヒーが好き",
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
		await expect(
			memory.forget(input([`state:${"f".repeat(64)}`])),
		).rejects.toThrow("invalid_memory_item");
		const oldest = `state:${(1099).toString(16).padStart(64, "0")}`;
		expect((await memory.forget(input([oldest]))).completed).toBe(true);
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

test("forget refuses an unknown or foreign item before anything is journaled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-forget-pre-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), memoryTestMigrations);
		const journalPath = join(dir, "journal.jsonl");
		const memory = createMemoryService(
			store,
			createConversationService(store),
			createContinuityService(store),
			{ journalPath },
		);
		expect((await memory.recover()).healthy).toBe(true);
		await expect(
			memory.forget(input([`state:${"a".repeat(64)}`])),
		).rejects.toThrow("invalid_memory_item");
		expect(existsSync(journalPath)).toBe(false);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a forget that fails after it was journaled reports memory_forget_incomplete (409)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-forget-inc-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), memoryTestMigrations);
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
		const item = await saveItem(store, memory, {
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: "drink",
			text: "コーヒーが好き",
		});
		// The usage purge runs after the journal line: breaking its table fails the forget at that point.
		await store.write((db) => db.exec("DROP TABLE memory_usage"));
		await expect(memory.forget(input([item.id]))).rejects.toThrow(
			"memory_forget_incomplete",
		);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
