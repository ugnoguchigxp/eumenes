import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { specialistBlockReasonMigration } from "..";
import {
	memoryTestMigrations,
	setupMemory,
	type MemoryHarness,
} from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

test("specialist-dialogue blocks are lifted on their own: other reasons stay blocked", async () => {
	const h = await setupMemory();
	open.push(h);
	const specialist = await h.say("user", "専門担当への発言", "c1", "run-1");
	const scheduled = await h.say("user", "定期の問い合わせ", "c1", "run-2");
	await h.store.write((db) => {
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [specialist],
			reason: "specialist_dialogue",
		});
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [scheduled],
			reason: "scheduled_prompt",
		});
	});
	const blocked = () =>
		h.store.read((db) =>
			h.memory.blockedMessageIdsInTransaction(db, [specialist, scheduled]),
		);
	expect([...blocked()].sort()).toEqual([specialist, scheduled].sort());
	await h.store.write((db) =>
		h.memory.unblockSpecialistMessagesInTransaction(db, [
			specialist,
			scheduled,
		]),
	);
	expect([...blocked()]).toEqual([scheduled]);
	// Blocking again is idempotent.
	await h.store.write((db) => {
		for (const _ of [1, 2])
			h.memory.blockMessagesInTransaction(db, {
				conversationId: "c1",
				messageIds: [specialist],
				reason: "specialist_dialogue",
			});
	});
	expect(blocked().has(specialist)).toBe(true);
});

test("the reason migration keeps every block row and accepts the new reason", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-specialist-block-"));
	const path = join(dir, "db.sqlite3");
	try {
		const without = memoryTestMigrations.filter(
			(m) => m !== specialistBlockReasonMigration,
		);
		const old = openStore(path, without);
		await old.write((db) => {
			db.exec(`INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES
			 ('m1', 'c1', 'scheduled_prompt', NULL, 't1'), ('m2', 'c1', 'forgotten', 'f1', 't2'), ('m3', '', 'scheduled_prompt', NULL, 't3')`);
			expect(() =>
				db.exec(
					"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES ('x', 'c1', 'specialist_dialogue', NULL, 't')",
				),
			).toThrow();
		});
		await old.close();
		const upgraded = openStore(path, [
			...without,
			specialistBlockReasonMigration,
		]);
		try {
			expect(
				upgraded.read((db) =>
					db
						.query(
							"SELECT message_id AS id, conversation_id AS c, reason, forget_id AS f, created_at AS t FROM memory_message_block ORDER BY message_id",
						)
						.all(),
				),
			).toEqual([
				{ id: "m1", c: "c1", reason: "scheduled_prompt", f: null, t: "t1" },
				{ id: "m2", c: "c1", reason: "forgotten", f: "f1", t: "t2" },
				{ id: "m3", c: "", reason: "scheduled_prompt", f: null, t: "t3" },
			]);
			await upgraded.write((db) =>
				db.exec(
					"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES ('m4', 'c1', 'specialist_dialogue', NULL, 't4')",
				),
			);
			expect(
				upgraded.read((db) =>
					db
						.query(
							"SELECT name FROM sqlite_master WHERE type='index' AND name='memory_message_block_conversation'",
						)
						.all(),
				),
			).toHaveLength(1);
			await expect(
				upgraded.write((db) =>
					db.exec(
						"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES ('m5', 'c1', 'other', NULL, 't5')",
					),
				),
			).rejects.toThrow();
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
