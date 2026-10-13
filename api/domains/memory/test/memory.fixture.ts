import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	outboxMigration,
	retractionMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
} from "../../continuity";
import {
	agentHardeningMigration,
	turnVectorsMigration,
	contextWindowMigration,
	createMemoryService,
	migration,
} from "..";

/** A memory service on a real database, with no queue and no inference (the agent is not wired). */
export async function setupMemory(options: { clock?: string } = {}) {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-fixture-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		avatarMotionMigration,
		answerDeliveryMigration,
		outboxMigration,
		retractionMigration,
		continuityMigration,
		shortTermMigration,
		migration,
		contextWindowMigration,
		agentHardeningMigration,
		turnVectorsMigration,
		...memoryPackageMigrations,
	]);
	const time = { now: options.clock ?? "2026-10-13T12:00:00.000Z" };
	const clock = () => time.now;
	let counter = 0;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, clock);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock,
		id: () => `id-${++counter}`,
	});
	if (!(await memory.recover()).healthy) throw new Error("memory_not_healthy");
	let messages = 0;
	const harness = {
		dir,
		store,
		time,
		conversation,
		continuity,
		memory,
		/** Adds a message of the conversation; user messages get a run id of their own. */
		async say(
			role: "user" | "assistant",
			text: string,
			conversationId = "c1",
			runId?: string,
		) {
			const id = `m${++messages}`;
			await conversation.append({
				id,
				conversationId,
				role,
				text,
				createdAt: time.now,
				runId: runId ?? (role === "user" ? `run-${id}` : null),
			});
			return id;
		},
		window: (conversationId = "c1") =>
			store.write((db) => {
				const window = memory.windowForRunInTransaction(db, conversationId);
				if (!window) throw new Error("memory off");
				return window;
			}),
		/** Registers State through the API (a user-confirmed item with no provenance). */
		async seed(
			text: string,
			semanticKey: string,
			quote = text,
			kind: "preference" | "habit" = "preference",
		) {
			const messageId = await harness.say("user", `${text}。`, "seed");
			return memory.remember({
				conversationId: "seed",
				messageId,
				quote,
				kind,
				semanticKey,
				text,
				polarity: "affirmed",
			});
		},
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}
export type MemoryHarness = Awaited<ReturnType<typeof setupMemory>>;
