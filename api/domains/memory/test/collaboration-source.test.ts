import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLedger } from "../service/ledger";

test("privacy exclusion permits session-local source use; forget and its unapplied journal remain revoked", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE memory_message_block(message_id TEXT PRIMARY KEY,reason TEXT NOT NULL)",
		);
		for (const [id, reason] of [
			["session", "specialist_dialogue"],
			["forgotten", "forgotten"],
			["scheduled", "scheduled_prompt"],
		])
			db.query("INSERT INTO memory_message_block VALUES(?,?)").run(
				id!,
				reason!,
			);
		const journalBlocked = new Set(["journal-only"]);
		const ledger = createLedger({
			store: {} as never,
			continuity: {} as never,
			clock: () => "",
			journalBlocked,
		});
		expect(ledger.isBlockedInTransaction(db, "session")).toBe(true);
		expect(ledger.isSourceRevokedInTransaction(db, "session")).toBe(false);
		for (const id of ["forgotten", "scheduled", "journal-only"])
			expect(ledger.isSourceRevokedInTransaction(db, id)).toBe(true);
		journalBlocked.add("session");
		expect(ledger.isSourceRevokedInTransaction(db, "session")).toBe(true);
	} finally {
		db.close();
	}
});
