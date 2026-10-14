import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	createContinuityService,
	itemSourceMigration,
	migration,
	shortTermMigration,
} from "..";
import type { ContinuityKind } from "../contracts";

type Service = ReturnType<typeof createContinuityService>;
/** A note as the steward writes it (the only way notes are added). */
const addNote = (
	store: SqliteStore,
	service: Service,
	conversationId: string,
	input: { kind: ContinuityKind; text: string },
) =>
	store.write((db) =>
		service.addByAgentInTransaction(db, conversationId, {
			...input,
			sourceMessageIds: ["m1"],
		}),
	);

test("goals, decisions and open questions persist across restart and track revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-"));
	const file = join(dir, "db.sqlite3");
	try {
		const store = openStore(file, [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const service = createContinuityService(store);
		const goal = await addNote(store, service, "c1", {
			kind: "goal",
			text: "Rust移行",
		});
		await addNote(store, service, "c1", {
			kind: "open_question",
			text: "CIはどうする",
		});
		await addNote(store, service, "c2", { kind: "decision", text: "別の会話" });
		expect(service.list("c1").map((i) => i.kind)).toEqual([
			"goal",
			"open_question",
		]);
		const before = store.read((db) =>
			service.snapshotInTransaction(db, "c1"),
		).revision;
		expect(
			await store.write((db) =>
				service.closeByAgentInTransaction(db, goal.id, 1, "resolved"),
			),
		).toBe(true);
		expect(
			service.list("c1", true).find((i) => i.id === goal.id),
		).toMatchObject({ status: "resolved", revision: 2 });
		expect(
			await store.write((db) =>
				service.closeByAgentInTransaction(db, goal.id, 1, "retracted"),
			),
		).toBe(false);
		expect(service.list("c1").map((i) => i.id)).not.toContain(goal.id);
		expect(service.list("c1", true)).toHaveLength(2);
		expect(
			store.read((db) => service.snapshotInTransaction(db, "c1")).revision,
		).toBe(before + 1);
		await store.close();
		const reopened = openStore(file, [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		expect(createContinuityService(reopened).list("c1")).toHaveLength(1);
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the short-term migration keeps existing rows and their order, and accepts the new kinds", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-mig-"));
	const file = join(dir, "db.sqlite3");
	try {
		const old = openStore(file, [migration]);
		await old.write((db) => {
			for (const [id, kind] of [
				["b", "goal"],
				["a", "decision"],
			] as const)
				db.query(
					"INSERT INTO continuity_items (id, conversation_id, kind, text, status, revision, created_at, updated_at) VALUES (?, 'c1', ?, ?, 'active', 3, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')",
				).run(id, kind, `text-${id}`);
		});
		await old.close();
		const store = openStore(file, [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const service = createContinuityService(store);
		const items = service.list("c1");
		expect(items.map((i) => i.id)).toEqual(["b", "a"]);
		expect(items[0]).toMatchObject({
			revision: 3,
			origin: "user",
			sourceMessageIds: [],
			expiresAt: null,
			updatedAt: "2026-10-02T00:00:00Z",
		});
		await addNote(store, service, "c1", { kind: "activity", text: "調べもの" });
		await addNote(store, service, "c1", { kind: "memo", text: "メモ" });
		expect(service.list("c1").map((i) => i.kind)).toEqual([
			"goal",
			"decision",
			"activity",
			"memo",
		]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("activity lives 14 days and memo 7; an expired item stays active but leaves the snapshot", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-ttl-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const time = { now: "2026-10-01T00:00:00.000Z" };
		let n = 0;
		const service = createContinuityService(
			store,
			() => time.now,
			() => `i${++n}`,
		);
		const activity = await addNote(store, service, "c1", {
			kind: "activity",
			text: "A",
		});
		const memo = await addNote(store, service, "c1", {
			kind: "memo",
			text: "M",
		});
		const goal = await addNote(store, service, "c1", {
			kind: "goal",
			text: "G",
		});
		expect(activity.expiresAt).toBe("2026-10-15T00:00:00.000Z");
		expect(memo.expiresAt).toBe("2026-10-08T00:00:00.000Z");
		expect(goal.expiresAt).toBeNull();
		const snapshot = () =>
			store.read((db) => service.snapshotInTransaction(db, "c1"));
		expect(snapshot().items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
		time.now = "2026-10-08T00:00:00.000Z";
		expect(snapshot().items.map((i) => i.id)).toEqual(["i1", "i3"]);
		time.now = "2026-10-20T00:00:00.000Z";
		expect(snapshot().items.map((i) => i.id)).toEqual(["i3"]);
		// Expiry changes no status and no revision: only the time moved.
		expect(service.list("c1").map((i) => i.status)).toEqual([
			"active",
			"active",
			"active",
		]);
		expect(snapshot().revision).toBe(3);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the steward's operations bump the revision and honour revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-agent-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const time = { now: "2026-10-01T00:00:00.000Z" };
		const service = createContinuityService(store, () => time.now);
		const revision = () =>
			store.read((db) => service.revisionInTransaction(db, "c1"));
		const added = await store.write((db) =>
			service.addByAgentInTransaction(db, "c1", {
				kind: "activity",
				text: "移行の調査",
				sourceMessageIds: ["m1"],
			}),
		);
		expect(added).toMatchObject({
			origin: "agent",
			sourceMessageIds: ["m1"],
			revision: 1,
			expiresAt: "2026-10-15T00:00:00.000Z",
		});
		expect(revision()).toBe(1);
		time.now = "2026-10-05T00:00:00.000Z";
		const updated = await store.write((db) =>
			service.updateByAgentInTransaction(db, added.id, 1, {
				text: "移行の調査(続き)",
			}),
		);
		expect(updated).toMatchObject({
			text: "移行の調査(続き)",
			revision: 2,
			// The life starts again from the rewrite.
			expiresAt: "2026-10-19T00:00:00.000Z",
		});
		expect(revision()).toBe(2);
		// A stale revision is a null, not an exception.
		expect(
			await store.write((db) =>
				service.updateByAgentInTransaction(db, added.id, 1, { text: "古い" }),
			),
		).toBeNull();
		expect(
			await store.write((db) =>
				service.closeByAgentInTransaction(db, added.id, 1, "resolved"),
			),
		).toBe(false);
		expect(
			await store.write((db) =>
				service.closeByAgentInTransaction(db, added.id, 2, "resolved"),
			),
		).toBe(true);
		expect(revision()).toBe(3);
		expect(service.list("c1")).toHaveLength(0);
		// A closed item cannot be rewritten.
		expect(
			await store.write((db) =>
				service.updateByAgentInTransaction(db, added.id, 3, { text: "x" }),
			),
		).toBeNull();
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the guard and the item limit apply to the steward, and expired items do not count", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-limit-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const time = { now: "2026-10-01T00:00:00.000Z" };
		const service = createContinuityService(store, () => time.now);
		service.setGuard((db, conversationId) => {
			const total = (
				db
					.query(
						"SELECT SUM(length(text)) AS n FROM continuity_items WHERE conversation_id=?",
					)
					.get(conversationId) as { n: number }
			).n;
			if (total > 100) throw new Error("invalid_continuity_limit");
		});
		const add = (text: string, kind: "memo" | "goal" = "memo") =>
			store.write((db) =>
				service.addByAgentInTransaction(db, "c1", {
					kind,
					text,
					sourceMessageIds: ["m1"],
				}),
			);
		await add("x".repeat(60));
		// The guard rolls the whole addition back.
		await expect(add("y".repeat(60))).rejects.toThrow(
			"invalid_continuity_limit",
		);
		expect(service.list("c1")).toHaveLength(1);
		const id = service.list("c1")[0]!.id;
		await expect(
			store.write((db) =>
				service.updateByAgentInTransaction(db, id, 1, {
					text: "z".repeat(200),
				}),
			),
		).rejects.toThrow("invalid_continuity_limit");
		expect(service.list("c1")[0]).toMatchObject({ revision: 1 });
		await store.close();
		const dir2 = mkdtempSync(join(tmpdir(), "eumenes-continuity-limit2-"));
		try {
			const other = openStore(join(dir2, "db.sqlite3"), [
				migration,
				shortTermMigration,
				itemSourceMigration,
			]);
			const clock = { now: "2026-10-01T00:00:00.000Z" };
			const svc = createContinuityService(other, () => clock.now);
			for (let i = 0; i < 30; i++)
				await other.write((db) =>
					svc.addByAgentInTransaction(db, "c1", {
						kind: "memo",
						text: `m${i}`,
						sourceMessageIds: ["m1"],
					}),
				);
			await expect(
				other.write((db) =>
					svc.addByAgentInTransaction(db, "c1", {
						kind: "goal",
						text: "31",
						sourceMessageIds: ["m1"],
					}),
				),
			).rejects.toThrow("invalid_continuity_limit");
			// Memos expire after seven days: the room is back.
			clock.now = "2026-10-09T00:00:00.000Z";
			await addNote(other, svc, "c1", { kind: "goal", text: "again" });
			await other.close();
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deleting by source message removes the notes and their text for good, moves the revision, and is idempotent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-del-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const service = createContinuityService(store);
		const mk = (
			conversationId: string,
			text: string,
			...sourceMessageIds: string[]
		) =>
			store.write((db) =>
				service.addByAgentInTransaction(db, conversationId, {
					kind: "memo",
					text,
					sourceMessageIds,
				}),
			);
		const a = await mk("c1", "忘れるべきメモ", "m1");
		const b = await mk("c1", "残すメモ", "m2");
		const closed = await mk("c2", "閉じた後も消すメモ", "m1");
		await store.write((db) =>
			service.closeByAgentInTransaction(db, closed.id, 1, "resolved"),
		);
		const before = service.snapshot("c1").revision;
		const result = await store.write((db) =>
			service.deleteBySourceMessagesInTransaction(db, ["m1", "m1", "none"]),
		);
		expect(result.deleted).toBe(2);
		expect(new Set(result.noteIds)).toEqual(new Set([a.id, closed.id]));
		expect(service.snapshot("c1").revision).toBeGreaterThan(before);
		expect(service.list("c1", true).map((n) => n.id)).toEqual([b.id]);
		expect(service.list("c2", true)).toEqual([]);
		const dump = store.read((db) =>
			JSON.stringify([
				db.query("SELECT * FROM continuity_items").all(),
				db.query("SELECT * FROM continuity_item_source").all(),
				db.query("SELECT * FROM continuity_revisions").all(),
			]),
		);
		expect(dump).not.toContain("忘れるべきメモ");
		expect(dump).not.toContain("閉じた後も消すメモ");
		const again = await store.write((db) =>
			service.deleteBySourceMessagesInTransaction(db, ["m1"]),
		);
		expect(again).toEqual({ noteIds: [], deleted: 0 });
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a note has many sources: any one of them deletes it, an update adds sources, and old single sources are carried over", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-src-"));
	try {
		// A database from before the source table: its single source column is copied, then the column goes.
		const legacy = openStore(join(dir, "legacy.sqlite3"), [
			migration,
			shortTermMigration,
		]);
		await legacy.write((db) =>
			db
				.query(
					"INSERT INTO continuity_items (id, conversation_id, kind, text, status, revision, created_at, updated_at, origin, source_message_id, expires_at) VALUES ('old','c1','memo','古いメモ','active',1,'t','t','agent','m9',NULL)",
				)
				.run(),
		);
		await legacy.close();
		const store = openStore(join(dir, "legacy.sqlite3"), [
			migration,
			shortTermMigration,
			itemSourceMigration,
		]);
		const service = createContinuityService(store);
		expect(service.list("c1")[0]).toMatchObject({
			id: "old",
			sourceMessageIds: ["m9"],
		});
		expect(
			store.read((db) =>
				(
					db.query("PRAGMA table_info(continuity_items)").all() as Array<{
						name: string;
					}>
				).map((column) => column.name),
			),
		).not.toContain("source_message_id");

		const note = await store.write((db) =>
			service.addByAgentInTransaction(db, "c1", {
				kind: "memo",
				text: "二つの発言から",
				sourceMessageIds: ["m1", "m2", "m1"],
			}),
		);
		expect(note.sourceMessageIds).toEqual(["m1", "m2"]);
		const updated = await store.write((db) =>
			service.updateByAgentInTransaction(db, note.id, 1, {
				text: "三つの発言から",
				addSourceMessageIds: ["m2", "m3"],
			}),
		);
		expect(updated?.sourceMessageIds).toEqual(["m1", "m2", "m3"]);
		// Without new sources the existing ones stay.
		const rewritten = await store.write((db) =>
			service.updateByAgentInTransaction(db, note.id, 2, { text: "そのまま" }),
		);
		expect(rewritten?.sourceMessageIds).toEqual(["m1", "m2", "m3"]);
		// One source in the set is enough.
		const result = await store.write((db) =>
			service.deleteBySourceMessagesInTransaction(db, ["m3"]),
		);
		expect(result).toEqual({ noteIds: [note.id], deleted: 1 });
		expect(
			store.read((db) =>
				db
					.query("SELECT * FROM continuity_item_source WHERE item_id = ?")
					.all(note.id),
			),
		).toEqual([]);
		expect(service.list("c1").map((item) => item.id)).toEqual(["old"]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
