import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	outboxMigration,
	retractionMigration,
} from "../../conversation";
import {
	type ContinuityKind,
	type ContinuityService,
	migration as continuityMigration,
	shortTermMigration,
	itemSourceMigration,
} from "../../continuity";
import {
	agentHardeningMigration,
	contextWindowMigration,
	migration as memoryMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	turnVectorsMigration,
	type MemoryItemDto,
	type MemoryService,
} from "../../memory";

/** The migrations a dialogue test with a real memory service needs, before dialogue's own. */
export const memoryMigrations = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	outboxMigration,
	retractionMigration,
	continuityMigration,
	shortTermMigration,
	itemSourceMigration,
	memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	...memoryPackageMigrations,
];

export type SeedInput = {
	conversationId: string;
	messageId: string;
	quote?: string | null;
	kind: "preference" | "personal_fact" | "constraint" | "habit";
	semanticKey: string;
	text: string;
	validFrom?: string;
	validUntil?: string;
};

/** Saves one State item through the steward's save contract (as a request the user made) and returns it. */
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
					messageId: input.messageId,
					quote: input.quote ?? null,
					...(input.validFrom ? { validFrom: input.validFrom } : {}),
					...(input.validUntil ? { validUntil: input.validUntil } : {}),
					explicit: true,
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

/** Writes a short-term note the way the steward does (its source message need not exist); a refusal throws. */
export function addNote(
	store: SqliteStore,
	continuity: ContinuityService,
	conversationId: string,
	input: { kind: ContinuityKind; text: string },
) {
	return store.write((db) =>
		continuity.addByAgentInTransaction(db, conversationId, {
			...input,
			sourceMessageIds: ["note-source"],
		}),
	);
}
