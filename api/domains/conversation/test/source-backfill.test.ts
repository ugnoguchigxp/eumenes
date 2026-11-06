import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService, migrations } from "..";

test("source backfill is bounded, atomic, idempotent and uses current live revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conversation-backfill-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	const service = createConversationService(store, { requireOutbox: true });
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO conversations (id, created_at) VALUES ('c', '2026-01-01')",
			).run();
			for (const id of ["a", "b", "gone", "c"])
				db.query(
					"INSERT INTO messages (id, conversation_id, role, text, created_at, retracted_at) VALUES (?, 'c', 'user', ?, '2026-01-01', ?)",
				).run(
					id,
					id === "gone" ? "" : `本文${id}`,
					id === "gone" ? "2026-01-02" : null,
				);
		});
		await expect(
			store.write((db) => {
				service.backfillSourceEventsInTransaction(db, 0, 1);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(
			store.read((db) => service.changesInTransaction(db, 0, 100)),
		).toEqual([]);
		const first = await store.write((db) =>
			service.backfillSourceEventsInTransaction(db, 0, 1),
		);
		expect(first).toMatchObject({ added: 1, hasMore: true });
		// A correction supplies b's event before the next page; the backfill must not add another.
		await service.correct({ messageId: "b", text: "訂正された本文" });
		await service.retract({ messageId: "c" });
		const tail = await store.write((db) =>
			service.backfillSourceEventsInTransaction(db, first.after, 1),
		);
		expect(tail).toMatchObject({ added: 0, hasMore: false });
		expect(
			await store.write((db) => service.backfillSourceEventsInTransaction(db)),
		).toMatchObject({
			added: 0,
			hasMore: false,
		});
		const events = store.read((db) => service.changesInTransaction(db, 0, 100));
		expect(events.map((e) => [e.sourceId, e.kind])).toEqual([
			["a", "added"],
			["b", "corrected"],
			["c", "retracted"],
		]);
		const current = store.read((db) => service.sourceInTransaction(db, "b"));
		expect(current.state).toBe("available");
		if (current.state === "available")
			expect(events[1]?.revision).toBe(current.revision);
		expect(JSON.stringify(events)).not.toContain("本文");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
