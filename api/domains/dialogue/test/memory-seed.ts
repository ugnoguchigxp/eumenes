import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { MemoryItemDto, MemoryService } from "../../memory";

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
