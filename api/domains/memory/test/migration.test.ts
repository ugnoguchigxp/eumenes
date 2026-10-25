import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../conversation";
import { migrations as packageSql } from "eumenes-memory/sqlite";
import {
	createMemoryService,
	migrations as hostMemoryMigrations,
	seedImportMigration,
	executionReferencesMigration,
	specialistBlockReasonMigration,
	stewardLedgersMigration,
	retireExchangeLedgerMigration,
	dropWindowPrefetchMigration,
} from "..";
import {
	createContinuityService,
	migrations as continuityMigrations,
} from "../../continuity";
import { blockedInConversation } from "../repository";
import { memoryTestMigrations } from "./memory.fixture";

test("adding the Seed migration preserves existing memory, conversation and connection settings", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-seed-upgrade-"));
	const path = join(dir, "db.sqlite3");
	const journalPath = join(dir, "journal.jsonl");
	const all = [
		...conversationMigrations,
		...continuityMigrations,
		...hostMemoryMigrations,
		...packageSql.map((sql, i) => ({ id: `package/${i + 1}`, sql })),
	];
	let store = openStore(
		path,
		all.filter(
			(m) =>
				m.sql !== executionReferencesMigration &&
				m.sql !== seedImportMigration &&
				m.sql !== retireExchangeLedgerMigration &&
				m.sql !== dropWindowPrefetchMigration &&
				m.sql !== specialistBlockReasonMigration,
		),
	);
	const create = () =>
		createMemoryService(
			store,
			createConversationService(store),
			createContinuityService(store),
			{ journalPath },
		);
	try {
		const memory = create();
		expect((await memory.recover()).healthy).toBe(true);
		await createConversationService(store).append({
			id: "before",
			conversationId: "old",
			role: "user",
			text: "既存の記憶",
			createdAt: "2026-10-01T00:00:00Z",
			runId: "run-old",
		});
		await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "old",
				items: [
					{
						op: "remember",
						kind: "preference",
						key: "old.preference",
						text: "既存の記憶",
						messageId: "before",
						explicit: true,
					},
				],
			}),
		);
		await memory.setEnabled(false);
		const before = memory.list(true);
		expect(before).toHaveLength(1);
		await store.close();
		store = openStore(path, all);
		const upgraded = create();
		expect((await upgraded.recover()).healthy).toBe(true);
		expect(upgraded.list(true)).toEqual(before);
		expect(upgraded.status()).toMatchObject({ enabled: false, healthy: true });
		expect(
			store.read((db) =>
				db.query("SELECT text FROM messages WHERE id = 'before'").get(),
			),
		).toEqual({ text: "既存の記憶" });
		expect(
			store.read((db) => db.query("SELECT * FROM memory_seed_import").all()),
		).toEqual([]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("memory/0005-steward-ledgers moves the old exclusions to unscoped scheduled_prompt blocks and drops the agent's tables", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-0005-"));
	try {
		const path = join(dir, "db.sqlite3");
		const without = memoryTestMigrations.filter(
			(migration) =>
				migration !== stewardLedgersMigration &&
				migration !== retireExchangeLedgerMigration &&
				migration !== specialistBlockReasonMigration,
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
		const upgraded = openStore(path, [
			...without,
			stewardLedgersMigration,
			retireExchangeLedgerMigration,
		]);
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
					conversationId: "",
					reason: "scheduled_prompt",
					forgetId: null,
				},
			]);
			// An unscoped block is read as a block of every conversation.
			expect(
				upgraded.read((db) => blockedInConversation(db, "c1")).sort(),
			).toEqual(["gone-message", "scheduled-1"]);
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
			// The exchange ledger and the summary are kept under retired names until the startup backfill.
			for (const retired of [
				"memory_exchange",
				"memory_conversation_summary",
				"memory_summary_source",
			])
				expect(tables).not.toContain(retired);
			for (const added of [
				"memory_retired_exchange",
				"memory_retired_summary",
				"memory_retired_summary_source",
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
