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
	stewardLedgersMigration,
	contextWindowMigration,
	createMemoryService,
	migration,
} from "..";
import type {
	CurationItem,
	CurationResult,
	MemoryEmbed,
	MemoryItemDto,
} from "../contracts";
import type { MemoryService } from "../service";

/** Every migration the memory domain needs, in dependency order (the tests open their stores with it). */
export const memoryTestMigrations = [
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
	stewardLedgersMigration,
	...memoryPackageMigrations,
];

/** What a test saves: the old manual call's fields, written through the steward's save contract as an explicit request. */
export type SeedInput = {
	conversationId: string;
	messageId: string;
	quote?: string | null;
	kind: "preference" | "personal_fact" | "constraint" | "habit";
	semanticKey: string;
	text: string;
	polarity?: "affirmed" | "negated";
	validFrom?: string;
	validUntil?: string;
	/** false: written as the steward's own inference. */
	explicit?: boolean;
};
/** Saves one State item and returns it; a rejected element is a test error. */
export async function saveItem(
	store: SqliteStore,
	memory: MemoryService,
	input: SeedInput,
): Promise<MemoryItemDto> {
	const [result] = await store.write((db) =>
		memory.applyCurationInTransaction(db, {
			conversationId: input.conversationId,
			items: [
				{
					op: "remember",
					kind: input.kind,
					key: input.semanticKey,
					text: input.text,
					negated: input.polarity === "negated",
					messageId: input.messageId,
					quote: input.quote ?? null,
					...(input.validFrom ? { validFrom: input.validFrom } : {}),
					...(input.validUntil ? { validUntil: input.validUntil } : {}),
					explicit: input.explicit !== false,
				},
			],
		}),
	);
	if (!result || result.status !== "applied")
		throw new Error(`curation rejected: ${JSON.stringify(result)}`);
	const item = memory.list(true).find((entry) => entry.id === result.id);
	if (!item) throw new Error("saved item not listed");
	return item;
}

/** A memory service on a real database, with no queue and no inference. */
export async function setupMemory(
	options: { clock?: string; embed?: MemoryEmbed } = {},
) {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-fixture-"));
	const store: SqliteStore = openStore(
		join(dir, "db.sqlite3"),
		memoryTestMigrations,
	);
	const time = { now: options.clock ?? "2026-10-13T12:00:00.000Z" };
	const clock = () => time.now;
	let counter = 0;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, clock);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock,
		id: () => `id-${++counter}`,
		...(options.embed ? { embed: () => options.embed } : {}),
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
			return saveItem(store, memory, {
				conversationId: "seed",
				messageId,
				quote,
				kind,
				semanticKey,
				text,
			});
		},
		/** Saves one item (see `saveItem`). */
		remember: (input: SeedInput) => saveItem(store, memory, input),
		/** The steward's save, element by element. */
		curate: (
			items: CurationItem[],
			conversationId = "c1",
		): Promise<CurationResult[]> =>
			store.write((db) =>
				memory.applyCurationInTransaction(db, { conversationId, items }),
			),
		/** Stops one item (a steward decision), at the revision the caller saw. */
		async stop(id: string, revision: number) {
			const [result] = await harness.curate([
				{ op: "stop", itemId: id, revision },
			]);
			if (!result || result.status !== "applied")
				throw new Error(`stop rejected: ${JSON.stringify(result)}`);
			return memory.list(true).find((entry) => entry.id === id)!;
		},
		/** Forgets items (and, when given, messages) the way the steward does. */
		forget: (
			itemIds: string[],
			messageIds: string[] = [],
			conversationId = "c1",
		) => memory.forget({ conversationId, itemIds, messageIds }),
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}
export type MemoryHarness = Awaited<ReturnType<typeof setupMemory>>;
