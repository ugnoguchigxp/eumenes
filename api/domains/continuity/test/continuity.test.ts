import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createContinuityService, migration, shortTermMigration } from "..";

test("goals, decisions and open questions persist across restart and track revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-"));
	const file = join(dir, "db.sqlite3");
	try {
		const store = openStore(file, [migration, shortTermMigration]);
		const service = createContinuityService(store);
		const goal = await service.add("c1", { kind: "goal", text: "Rust移行" });
		await service.add("c1", { kind: "open_question", text: "CIはどうする" });
		await service.add("c2", { kind: "decision", text: "別の会話" });
		expect(service.list("c1").map((i) => i.kind)).toEqual([
			"goal",
			"open_question",
		]);
		const before = store.read((db) =>
			service.snapshotInTransaction(db, "c1"),
		).revision;
		const closed = await service.transition(goal.id, {
			expectedRevision: 1,
			status: "resolved",
		});
		expect(closed).toMatchObject({ status: "resolved", revision: 2 });
		await expect(
			service.transition(goal.id, { expectedRevision: 1, status: "retracted" }),
		).rejects.toThrow("revision_conflict");
		expect(service.list("c1").map((i) => i.id)).not.toContain(goal.id);
		expect(service.list("c1", true)).toHaveLength(2);
		expect(
			store.read((db) => service.snapshotInTransaction(db, "c1")).revision,
		).toBe(before + 1);
		await store.close();
		const reopened = openStore(file, [migration, shortTermMigration]);
		expect(createContinuityService(reopened).list("c1")).toHaveLength(1);
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the user-change hook runs inside the transition transaction and never for an addition", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-hook-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
		]);
		const service = createContinuityService(store);
		const calls: string[] = [];
		service.setUserChangeHook((db) => {
			// Same transaction: the closed state is already visible to the hook.
			calls.push(
				(
					db.query("SELECT status FROM continuity_items").get() as {
						status: string;
					}
				).status,
			);
		});
		const goal = await service.add("c1", { kind: "goal", text: "Rust移行" });
		expect(calls).toEqual([]);
		await expect(
			service.transition(goal.id, { expectedRevision: 9, status: "resolved" }),
		).rejects.toThrow("revision_conflict");
		expect(calls).toEqual([]);
		await service.transition(goal.id, {
			expectedRevision: 1,
			status: "resolved",
		});
		expect(calls).toEqual(["resolved"]);
		await store.close();
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
		const store = openStore(file, [migration, shortTermMigration]);
		const service = createContinuityService(store);
		const items = service.list("c1");
		expect(items.map((i) => i.id)).toEqual(["b", "a"]);
		expect(items[0]).toMatchObject({
			revision: 3,
			origin: "user",
			sourceMessageId: null,
			expiresAt: null,
			updatedAt: "2026-10-02T00:00:00Z",
		});
		await service.add("c1", { kind: "activity", text: "調べもの" });
		await service.add("c1", { kind: "memo", text: "メモ" });
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
		]);
		const time = { now: "2026-10-01T00:00:00.000Z" };
		let n = 0;
		const service = createContinuityService(
			store,
			() => time.now,
			() => `i${++n}`,
		);
		const activity = await service.add("c1", { kind: "activity", text: "A" });
		const memo = await service.add("c1", { kind: "memo", text: "M" });
		const goal = await service.add("c1", { kind: "goal", text: "G" });
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

test("the memory agent's operations bump the revision, honour revisions, and never call the user hook", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-agent-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
		]);
		const time = { now: "2026-10-01T00:00:00.000Z" };
		const service = createContinuityService(store, () => time.now);
		let hooks = 0;
		service.setUserChangeHook(() => hooks++);
		const revision = () =>
			store.read((db) => service.revisionInTransaction(db, "c1"));
		const added = await store.write((db) =>
			service.addByAgentInTransaction(db, "c1", {
				kind: "activity",
				text: "移行の調査",
				sourceMessageId: "m1",
			}),
		);
		expect(added).toMatchObject({
			origin: "agent",
			sourceMessageId: "m1",
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
		expect(hooks).toBe(0);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the guard and the item limit apply to the memory agent, and expired items do not count", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-limit-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			shortTermMigration,
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
					sourceMessageId: "m1",
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
			]);
			const clock = { now: "2026-10-01T00:00:00.000Z" };
			const svc = createContinuityService(other, () => clock.now);
			for (let i = 0; i < 30; i++)
				await other.write((db) =>
					svc.addByAgentInTransaction(db, "c1", {
						kind: "memo",
						text: `m${i}`,
						sourceMessageId: "m1",
					}),
				);
			await expect(
				other.write((db) =>
					svc.addByAgentInTransaction(db, "c1", {
						kind: "goal",
						text: "31",
						sourceMessageId: "m1",
					}),
				),
			).rejects.toThrow("invalid_continuity_limit");
			await expect(
				svc.add("c1", { kind: "goal", text: "user" }),
			).rejects.toThrow("invalid_continuity_limit");
			// Memos expire after seven days: the room is back.
			clock.now = "2026-10-09T00:00:00.000Z";
			await svc.add("c1", { kind: "goal", text: "user" });
			await other.close();
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
