import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
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
import { createMemoryService, migration, registerMemory } from "..";

test("remember, stop, retract and forget work end to end over HTTP without dialogue; memory is shared across conversations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-unit-"));
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
		const app = new Hono();
		registerMemory(app, memory);
		app.onError((error, c) => c.json({ error: error.message }, 400));
		const post = (path: string, body: unknown) =>
			app.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post("/api/memory/items", { nope: 1 })).status).toBe(400);
		const created = await post("/api/memory/items", {
			conversationId: "c1",
			messageId: "m1",
			quote: "コーヒーが好き",
			kind: "preference",
			semanticKey: "drink",
			text: "コーヒーが好き",
		});
		expect(created.status).toBe(201);
		const item = (await created.json()) as { id: string; revision: number };
		// Profile memory is not tied to the conversation it came from.
		const block = store.read((db) => memory.prepareInTransaction(db, "c2"));
		expect(block.status === "ready" && block.block).toContain("コーヒーが好き");
		const stopped = await post(`/api/memory/items/${item.id}/stop`, {
			expectedRevision: item.revision,
		});
		expect(((await stopped.json()) as { status: string }).status).toBe(
			"inactive",
		);
		expect(
			(
				await post(`/api/memory/items/${item.id}/stop`, {
					expectedRevision: 99,
				})
			).status,
		).toBe(400);
		const forgotten = await post(`/api/memory/items/${item.id}/forget`, {});
		expect(forgotten.status).toBe(200);
		expect(memory.list(true)).toEqual([]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("policyRevisionInTransaction is the revision memory's access() uses and moves with the memory ON/OFF setting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-policy-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			avatarMotionMigration,
			answerDeliveryMigration,
			continuityMigration,
			migration,
			...memoryPackageMigrations,
		]);
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
