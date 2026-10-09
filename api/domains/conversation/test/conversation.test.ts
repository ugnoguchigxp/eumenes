import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, WriterOwnedError } from "../../../infrastructure/sqlite";
import {
	createConversationService,
	migration,
	avatarMotionMigration,
	answerDeliveryMigration,
} from "..";

test("conversation saves and survives reopen; second writer is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-"));
	const file = join(dir, "test.sqlite3");
	try {
		const store = openStore(file, [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
		]);
		const service = createConversationService(store);
		await service.append({
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "こんにちは",
			createdAt: "2026-01-01T00:00:00Z",
			runId: null,
		});
		expect(service.get("c1").revision).toBe(1);
		expect(() =>
			openStore(file, [
				migration,
				avatarMotionMigration,
				answerDeliveryMigration,
			]),
		).toThrow(WriterOwnedError);
		await store.close();
		const reopened = openStore(file, [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
		]);
		expect(
			createConversationService(reopened).get("c1").messages[0]?.text,
		).toBe("こんにちは");
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("answer motion can arrive before text, keeps the first choice, and survives upgrade/reopen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-answer-motion-"));
	const file = join(dir, "test.sqlite3");
	const user = {
		id: "user",
		conversationId: "main",
		role: "user" as const,
		text: "よかった",
		createdAt: new Date().toISOString(),
		runId: "run",
	};
	let store = openStore(file, [migration]);
	try {
		await createConversationService(store).append(user);
		await store.close();
		store = openStore(file, [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
		]);
		const service = createConversationService(store);
		expect(service.get("main").messages[0]).toEqual(user);
		await expect(
			store.write((db) => {
				service.recordAnswerMotionInTransaction(db, "run", "main", "downcast");
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await store.write((db) =>
			service.recordAnswerMotionInTransaction(db, "run", "main", "joyful"),
		);
		await store.write((db) =>
			expect(
				service.recordAnswerMotionInTransaction(db, "run", "main", "surprised"),
			).toBe(false),
		);
		await service.append({
			...user,
			id: "answer",
			role: "assistant",
			text: "よかったですね。",
		});
		expect(service.get("main").revision).toBe(3);
		expect(service.get("main").messages[0]?.avatarMotion).toBeUndefined();
		expect(service.get("main").messages[1]?.avatarMotion).toBe("joyful");
		await store.close();
		store = openStore(file, [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
		]);
		expect(
			createConversationService(store).get("main").messages[1],
		).toMatchObject({ text: "よかったですね。", avatarMotion: "joyful" });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("answer-wide delivery persists provenance, upgrades fallback, and keeps an adopted none stable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-delivery-"));
	const file = join(dir, "test.sqlite3");
	const migrations = [
		migration,
		avatarMotionMigration,
		answerDeliveryMigration,
	];
	let store = openStore(file, migrations);
	try {
		const service = createConversationService(store);
		await service.append({
			id: "answer",
			conversationId: "main",
			role: "assistant",
			text: "素敵な由来ですね。",
			createdAt: "now",
			runId: "r",
		});
		const fallback = {
			id: crypto.randomUUID(),
			version: 2 as const,
			emotion: "none" as const,
			emotionConfidence: 0,
			confidence: 0,
			source: "fallback" as const,
			reason: "timeout" as const,
			motion: "neutral" as const,
			tone: "natural" as const,
			latencyMs: 2000,
		};
		const plain = {
			...fallback,
			id: crypto.randomUUID(),
			source: "laya" as const,
			reason: undefined,
			confidence: 0.9,
			emotionConfidence: 0.9,
		};
		await expect(
			store.write((db) => {
				service.recordAnswerDeliveryInTransaction(db, "r", "main", fallback);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(service.get("main").messages[0]?.delivery).toBeUndefined();
		await store.write((db) =>
			service.recordAnswerDeliveryInTransaction(db, "r", "main", fallback),
		);
		await store.write((db) =>
			service.recordAnswerDeliveryInTransaction(db, "r", "main", plain),
		);
		expect(
			await store.write((db) =>
				service.recordAnswerDeliveryInTransaction(db, "r", "main", {
					...plain,
					emotion: "joy",
					motion: "joyful",
				}),
			),
		).toBe(false);
		expect(service.get("main").revision).toBe(3);
		await store.close();
		store = openStore(file, migrations);
		expect(
			createConversationService(store).get("main").messages[0]?.delivery,
		).toEqual(plain);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
