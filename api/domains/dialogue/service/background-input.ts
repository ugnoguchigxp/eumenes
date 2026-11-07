import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import type { ConversationPrefix } from "./conversation-input";
import type { ReferenceInput } from "../../memory";
import { liveSession } from "../repository";
import { STATE_LIMITS } from "./state-text";
import { sha256Hex } from "../../../infrastructure/digest";

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
	const open = deps.work?.todosInTransaction(db, id) ?? [];
	const confirmations =
		deps.work?.pendingConfirmationsInTransaction(db, id) ?? [];
	const work = [
		...open,
		...(deps.work?.recentlyArchivedInTransaction(
			db,
			id,
			new Date(
				Math.max(
					Date.parse(deps.clock()) - STATE_LIMITS.archivedMs,
					prefix.since ?? -Infinity,
				),
			).toISOString(),
			Math.max(0, STATE_LIMITS.work - open.length - confirmations.length),
		) ?? []),
	];
	for (const item of work.slice(0, STATE_LIMITS.work)) {
		const row = deps.work?.workInTransaction(db, item.id);
		if (!row) {
			complete = false;
			continue;
		}
		messages.push(...row.messageIds);
		include(deps.memory?.referenceInputs.readRunInTransaction(db, row.runId));
		sources.add(`host-work:${JSON.stringify([row.id, row.revision])}`);
	}
	for (const item of confirmations) {
		const row = deps.work?.confirmationByRefInTransaction(db, id, item.ref);
		if (!row) {
			complete = false;
			continue;
		}
		messages.push(...(row.messageIds ?? []));
		if (!row.messageIds) complete = false;
		sources.add(
			`host-confirmation:${JSON.stringify([row.id, sha256Hex(JSON.stringify(row))])}`,
		);
	}
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
	// Legacy state and specialist records do not carry a complete input manifest.
	if (
		deps.contextKeeper &&
		deps.conversation.input.latestStateInTransaction(db, id)
	)
		complete = false;
	if (deps.specialist && liveSession(db, id)?.state === "suspended")
		complete = false;
	return { sources: [...sources], complete };
}
