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
	outboxMigration,
	retractionMigration,
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
			source: "system-one" as const,
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

test("ordinal reads: messages after a cursor, the newest ordinal and the n-th newest user message skip retracted rows", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-ordinals-"));
	try {
		const store = openStore(join(dir, "test.sqlite3"), [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
			outboxMigration,
			retractionMigration,
		]);
		const service = createConversationService(store);
		const add = (
			id: string,
			role: "user" | "assistant",
			conversationId = "c1",
		) =>
			service.append({
				id,
				conversationId,
				role,
				text: `text-${id}`,
				createdAt: "2026-01-01T00:00:00Z",
				runId: role === "user" ? `run-${id}` : null,
			});
		const read = <T>(
			fn: (db: Parameters<Parameters<typeof store.read>[0]>[0]) => T,
		) => store.read(fn);
		expect(read((db) => service.latestOrdinalInTransaction(db, "c1"))).toBe(0);
		expect(
			read((db) => service.nthLatestUserOrdinalInTransaction(db, "c1", 1)),
		).toBe(0);
		await add("u1", "user");
		await add("other", "user", "c2");
		await add("a1", "assistant");
		await add("u2", "user");
		await add("a2", "assistant");
		await add("u3", "user");
		const after = (cursor: number, limit = 10) =>
			read((db) =>
				service.messagesAfterInTransaction(db, "c1", cursor, limit),
			).map((entry) => [entry.message.id, entry.ordinal] as const);
		// Only this conversation, ascending, with the run link kept. Ordinals are shared across conversations.
		expect(after(0).map(([id]) => id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
		const ordinal = Object.fromEntries(after(0)) as Record<string, number>;
		const [o1, o2, o3, o4, o5] = [
			ordinal.u1!,
			ordinal.a1!,
			ordinal.u2!,
			ordinal.a2!,
			ordinal.u3!,
		];
		expect(o2).toBeGreaterThan(o1 + 1);
		expect(after(0)[0]?.[1]).toBe(o1);
		expect(
			read((db) => service.messagesAfterInTransaction(db, "c1", 0, 1))[0]
				?.message.runId,
		).toBe("run-u1");
		expect(after(o2).map(([id]) => id)).toEqual(["u2", "a2", "u3"]);
		expect(after(o5)).toEqual([]);
		expect(after(0, 2).map(([id]) => id)).toEqual(["u1", "a1"]);
		expect(read((db) => service.latestOrdinalInTransaction(db, "c1"))).toBe(o5);
		const nth = (n: number) =>
			read((db) => service.nthLatestUserOrdinalInTransaction(db, "c1", n));
		expect([nth(1), nth(2), nth(3), nth(4), nth(0)]).toEqual([
			o5,
			o3,
			o1,
			0,
			0,
		]);
		// A retracted message is gone from all three.
		await service.retract({ messageId: "u3" });
		expect(after(0).map(([id]) => id)).toEqual(["u1", "a1", "u2", "a2"]);
		expect(read((db) => service.latestOrdinalInTransaction(db, "c1"))).toBe(o4);
		expect([nth(1), nth(2), nth(3)]).toEqual([o3, o1, 0]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the retract hook runs inside the retraction while the message is still readable, and also for a missing message", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-hook-"));
	try {
		const store = openStore(join(dir, "test.sqlite3"), [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
			outboxMigration,
			retractionMigration,
		]);
		const service = createConversationService(store);
		const seen: Array<{ id: string; text: string | undefined; run: string[] }> =
			[];
		service.addRetractHook((db, messageId) => {
			const found = service.messageInTransaction(db, messageId);
			seen.push({
				id: messageId,
				text: found?.message.text,
				run: found?.message.runId
					? service
							.messagesOfRunInTransaction(
								db,
								found.message.conversationId,
								found.message.runId,
							)
							.map(({ message }) => message.id)
					: [],
			});
		});
		const add = (id: string, role: "user" | "assistant", runId: string) =>
			service.append({
				id,
				conversationId: "c1",
				role,
				text: `text-${id}`,
				createdAt: "2026-01-01T00:00:00Z",
				runId,
			});
		await add("u1", "user", "r1");
		await add("a1", "assistant", "r1");
		await service.retract({ messageId: "u1" });
		expect(seen).toEqual([{ id: "u1", text: "text-u1", run: ["u1", "a1"] }]);
		// Afterwards the retracted message is gone from the run's live messages.
		expect(
			store
				.read((db) => service.messagesOfRunInTransaction(db, "c1", "r1"))
				.map(({ message }) => message.id),
		).toEqual(["a1"]);
		await service.retract({ messageId: "nope" });
		expect(seen.at(-1)).toEqual({ id: "nope", text: undefined, run: [] });
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
