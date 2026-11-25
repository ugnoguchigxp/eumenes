import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import type { ConversationPrefix } from "./conversation-input";
import type { ReferenceInput } from "../../memory";
import { liveSession } from "../repository";

/** Same records as the background State renderer. No interpretation of formatted text. */
export function backgroundInput(
	deps: DialogueDeps,
	db: Database,
	id: string,
	prefix: ConversationPrefix,
): ReferenceInput {
	const sources = new Set<string>();
	let complete = true;
	const messages = prefix.recent.flatMap((u) =>
		u.messageId ? [u.messageId] : [],
	);
	if (prefix.recent.some((u) => !u.messageId)) complete = false;
	const include = (input: ReferenceInput | null | undefined) => {
		if (!input) {
			complete = false;
			return;
		}
		for (const ref of input.sources) sources.add(ref);
		complete &&= input.complete;
	};
	for (const ref of prefix.summarySourceRefs ?? []) sources.add(ref);
	const window = deps.memory?.storedWindowInTransaction(db, id);
	const itemRevisions = Object.fromEntries(
		(window?.profile.items ?? [])
			.filter((item) => prefix.memoryItemIds.includes(item.id))
			.map((item) => [item.id, item.revision]),
	);
	include(
		deps.memory
			? deps.memory.referenceInputs.captureInTransaction(db, {
					messageIds: messages,
					itemIds: prefix.memoryItemIds,
					itemRevisions,
				})
			: { sources: messages, complete: prefix.memoryItemIds.length === 0 },
	);
	include(
		deps.agency?.inputForContextInTransaction?.(db, id) ?? {
			sources: [],
			complete: true,
		},
	);
	// Specialist records do not carry a complete input manifest.
	if (deps.specialist && liveSession(db, id)?.state === "suspended")
		complete = false;
	return { sources: [...sources], complete };
}
