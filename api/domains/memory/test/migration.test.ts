import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { stewardLedgersMigration } from "..";
import { memoryTestMigrations } from "./memory.fixture";

test("memory/0005-steward-ledgers moves the old exclusions to scheduled_prompt blocks and drops the agent's tables", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-0005-"));
	try {
		const path = join(dir, "db.sqlite3");
		const without = memoryTestMigrations.filter(
			(migration) => migration !== stewardLedgersMigration,
		);
		const old = openStore(path, without);
		const conversation = createConversationService(old);
		await conversation.append({
			id: "scheduled-1",
			conversationId: "c1",
			role: "user",
			text: "定期の問い合わせ",
			createdAt: "2026-10-01T00:00:00Z",
			runId: null,
		});
		await old.write((db) => {
			db.exec(
				"INSERT INTO memory_agent_excluded_message (message_id) VALUES ('scheduled-1'), ('gone-message')",
			);
			db.exec(
				"INSERT INTO memory_agent_cursor (conversation_id, last_ordinal, failures) VALUES ('c1', 3, 0)",
			);
			db.exec(
				"INSERT INTO memory_agent_request (job_id, request_id) VALUES ('j', 'r')",
			);
			db.exec(
				"INSERT INTO memory_item_provenance (item_id, run_id, mode, created_at) VALUES ('state:x', NULL, 'agent', 't')",
			);
		});
		await old.close();
		const upgraded = openStore(path, [...without, stewardLedgersMigration]);
		try {
			const blocks = upgraded.read(
				(db) =>
					db
						.query(
							"SELECT message_id AS id, conversation_id AS conversationId, reason, forget_id AS forgetId FROM memory_message_block ORDER BY message_id",
						)
						.all() as Array<Record<string, unknown>>,
			);
			expect(blocks).toEqual([
				{
					id: "gone-message",
					conversationId: "",
					reason: "scheduled_prompt",
					forgetId: null,
				},
				{
					id: "scheduled-1",
					conversationId: "c1",
					reason: "scheduled_prompt",
					forgetId: null,
				},
			]);
			const tables = upgraded
				.read(
					(db) =>
						db
							.query(
								"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%'",
							)
							.all() as Array<{ name: string }>,
				)
				.map((row) => row.name);
			for (const gone of [
				"memory_agent_cursor",
				"memory_agent_request",
				"memory_agent_excluded_message",
			])
				expect(tables).not.toContain(gone);
			for (const added of [
				"memory_exchange",
				"memory_conversation_summary",
				"memory_summary_source",
				"memory_message_block",
				"memory_forget_fence",
			])
				expect(tables).toContain(added);
			expect(
				upgraded.read((db) =>
					db.query("SELECT seq FROM memory_forget_fence WHERE id = 1").get(),
				),
			).toEqual({ seq: 0 });
			// Rows written before the column existed read as "no quote involved".
			expect(
				upgraded.read((db) =>
					db
						.query("SELECT quote_matched AS q FROM memory_item_provenance")
						.get(),
				),
			).toEqual({ q: null });
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
