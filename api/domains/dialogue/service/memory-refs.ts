import type { Database } from "bun:sqlite";
import type { MemoryService, WindowSnapshot } from "../../memory";
import { saveMemoryRefs } from "../repository/memory-refs";
import type { DialogueDeps } from "./context";
import type { PreparedMemory } from "./memory-window";

/**
 * Hands out the short references (`m1`...) of the items `## Memory` shows (in the order it lists them) in the window
 * `windowKey`, and saves them for the reads that draw the same text again. The memory numbers them on, never reusing
 * one: the same item at the same version keeps its reference from one run to the next, a new window starts new ones.
 */
export function assignWindowRefs(
	memory: MemoryService,
	tx: Database,
	conversationId: string,
	windowKey: string,
	items: ReadonlyArray<{ id: string; revision: number }>,
): ReadonlyMap<string, string> {
	const refs = new Map(
		memory.shortRefs
			.assignInTransaction(tx, {
				conversationId,
				windowKey,
				items: items.map((item) => ({
					itemId: item.id,
					revision: item.revision,
				})),
			})
			.map((ref) => [ref.itemId, ref.ref] as const),
	);
	saveMemoryRefs(tx, conversationId, windowKey, refs);
	return refs;
}

/**
 * What the memory holds back from the conversation before its closure delete runs (the messages an immediate forget
 * excluded records stand on): the ones among `messageIds`. The history reads and the recent conversation leave them out.
 */
export function withheldIn(
	deps: DialogueDeps,
	db: Database,
	messageIds: readonly string[],
): ReadonlySet<string> {
	if (!deps.memory || messageIds.length === 0) return new Set();
	return new Set(deps.memory.withheldMessagesInTransaction(db, messageIds));
}

/**
 * The messages among `messageIds` that an excluded record stands on and no block holds yet (an immediate forget not yet
 * closed). A message the memory blocked for another reason (a specialist's dialogue, a scheduled prompt) stays in the
 * recent conversation: the host shows its own words there, and the closure delete clears the rest with their text.
 */
export function excludedOnlyIn(
	deps: DialogueDeps,
	db: Database,
	messageIds: readonly string[],
): ReadonlySet<string> {
	const withheld = withheldIn(deps, db, messageIds);
	if (withheld.size === 0 || !deps.memory) return withheld;
	const blocked = deps.memory.blockedMessageIdsInTransaction(db, [...withheld]);
	return new Set([...withheld].filter((id) => !blocked.has(id)));
}

/** What a run keeps of the memory it reads (fixed at prepare, in the claim transaction). */
export function preparedMemoryInTransaction(
	memory: MemoryService,
	tx: Database,
	input: {
		window: WindowSnapshot;
		shownMessageIds: readonly string[];
		refsKey: string;
	},
): PreparedMemory {
	return {
		window: memory.preparedWindow(input.window, input.shownMessageIds),
		blockedAtPrepare: [
			...memory.blockedMessageIdsInTransaction(tx, input.shownMessageIds),
		],
		refsKey: input.refsKey,
	};
}
