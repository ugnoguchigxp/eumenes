import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ShortRef } from "../contracts/immediate";
import {
	findShortRef,
	insertShortRef,
	readShortRef,
	readShortRefWindow,
	resetShortRefWindow,
} from "../repository/immediate";

/**
 * The short references (`m1`, `m2`, ...) of a conversation's window (section 7.2): what `## Memory` and the
 * `read_memory` results show instead of ids and versions, which never reach the model. The host resolves a reference
 * back to the item and the version it was handed out for.
 *
 * One window per conversation. It is named by `windowKey`; the profile's key is derived from what the profile shows
 * (`windowKeyOf`), so it holds while the profile is unchanged and changes at a re-publication. A new key
 * drops every earlier reference (they stop resolving: the model reads again). The numbers of a conversation only grow, so a reference left in the history never names another record. The
 * results of `read_memory` use the key of the window they were read beside, so their references continue the
 * profile's numbering and an item shown twice keeps its reference.
 */
export function createShortRefs() {
	return {
		/** The key of a published profile: the same items at the same versions, in the same order, are the same window. */
		windowKeyOf(
			items: ReadonlyArray<{ id: string; revision: number }>,
		): string {
			return sha256Hex(
				JSON.stringify(items.map((item) => [item.id, item.revision])),
			);
		},
		/**
		 * References for the items, in the order given (one each: an item at a version already referenced in this window
		 * keeps its reference). Writes: a writer transaction.
		 */
		assignInTransaction(
			db: Database,
			input: {
				conversationId: string;
				windowKey: string;
				items: ReadonlyArray<{ itemId: string; revision: number }>;
			},
		): ShortRef[] {
			const window = readShortRefWindow(db, input.conversationId);
			if (!window || window.windowKey !== input.windowKey)
				resetShortRefWindow(db, input.conversationId, input.windowKey);
			return input.items.map((item) => ({
				ref:
					findShortRef(db, input.conversationId, item.itemId, item.revision) ??
					insertShortRef(db, input.conversationId, item.itemId, item.revision),
				itemId: item.itemId,
				revision: item.revision,
			}));
		},
		/** The item and version a reference was handed out for in the conversation's current window. */
		resolveInTransaction(
			db: Database,
			conversationId: string,
			ref: string,
		): { itemId: string; revision: number } | null {
			const found = readShortRef(db, conversationId, ref.trim());
			return found ? { itemId: found.itemId, revision: found.revision } : null;
		},
	};
}
export type ShortRefs = ReturnType<typeof createShortRefs>;
