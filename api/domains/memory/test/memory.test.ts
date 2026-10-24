import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService, registerMemory } from "..";
import { memoryTestMigrations, saveItem } from "./memory.fixture";

test("save, stop and forget work without dialogue; memory is shared across conversations; no HTTP route changes it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-unit-"));
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
		const app = new Hono();
		registerMemory(app, memory);
		app.onError((error, c) => c.json({ error: error.message }, 400));
		expect(
			(
				await app.request("/api/memory/items", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ nope: 1 }),
				})
			).status,
		).toBe(404);
		const item = await saveItem(store, memory, {
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: "drink",
			text: "コーヒーが好き",
		});
		// Profile memory is not tied to the conversation it came from.
		const window = await store.write((db) =>
			memory.windowForRunInTransaction(db, "c2"),
		);
		expect(window?.profile.items.map((item) => item.text)).toEqual([
			"コーヒーが好き",
		]);
		if (!window) throw new Error("fixture_not_ready");
		const prepared = memory.preparedWindow(window);
		expect(
			store.read((db) =>
				memory.validateWindowInTransaction(db, "r1", prepared),
			),
		).toEqual({ ok: true });
		expect(
			store.read((db) =>
				db.query("SELECT count(*) AS n FROM memory_usage").get(),
			),
		).toEqual({ n: 0 });
		const [stopped] = await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [{ op: "stop", itemId: item.id, revision: item.revision }],
			}),
		);
		expect(stopped).toMatchObject({ status: "applied", op: "stop" });
		expect(memory.list(true)[0]?.status).toBe("inactive");
		expect(
			store.read((db) =>
				memory.validateWindowInTransaction(db, "r1", prepared),
			),
		).toEqual({ ok: false, reason: "memory_stale" });
		// A stale revision is refused, element by element.
		const [stale] = await store.write((db) =>
			memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [{ op: "stop", itemId: item.id, revision: 99 }],
			}),
		);
		expect(stale).toEqual({
			status: "rejected",
			op: "stop",
			reason: "item_changed",
		});
		await memory.forget({
			conversationId: "c1",
			itemIds: [item.id],
			messageIds: [],
		});
		expect(memory.list(true)).toEqual([]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("policyRevisionInTransaction is the revision memory's access() uses and moves with the memory ON/OFF setting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-policy-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), memoryTestMigrations);
		const memory = createMemoryService(
			store,
			createConversationService(store),
			createContinuityService(store),
			{ journalPath: join(dir, "journal.jsonl") },
		);
		const raw = (db: Database) =>
			String(
				(
					db
						.query("SELECT revision FROM memory_host_settings WHERE id = 1")
						.get() as { revision: number }
				).revision,
			);
		const before = store.read((db) => memory.policyRevisionInTransaction(db));
		expect(before).toBe(store.read(raw));
		await memory.setEnabled(false);
		const after = store.read((db) => memory.policyRevisionInTransaction(db));
		expect(after).toBe(store.read(raw));
		expect(after).not.toBe(before);
		// recover() reports whether change-feed subscribers must resync (false on a clean start).
		expect(await memory.recover()).toMatchObject({
			healthy: true,
			reapplied: 0,
		});
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
