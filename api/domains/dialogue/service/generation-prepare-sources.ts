import type { Database } from "bun:sqlite";
import { backgroundInput } from "./background-input";
import type { DialogueDeps } from "./context";
import type { ConversationPrefix } from "./conversation-input";
import { imageObservationInput } from "./generated-images";

export function recordPromptSources(
	deps: DialogueDeps,
	tx: Database,
	{
		runId,
		conversationId,
		prefix,
		pendingIds,
		media,
		notAdopted,
	}: {
		runId: string;
		conversationId: string;
		prefix: ConversationPrefix;
		pendingIds: ReadonlySet<string>;
		media: ReadonlyArray<{ rootId: string }>;
		notAdopted: boolean;
	},
) {
	const memory = deps.memory;
	if (!memory?.referenceInputs) return;
	const context = backgroundInput(deps, tx, conversationId, prefix);
	const pendingInput = memory.referenceInputs.captureInTransaction(tx, {
		messageIds: [...pendingIds],
	});
	const mediaInputs = media.map(({ rootId }) =>
		imageObservationInput(tx, rootId),
	);
	memory.referenceInputs.recordRunInTransaction(
		tx,
		runId,
		{
			sources: [
				...new Set([
					...context.sources,
					...pendingInput.sources,
					...mediaInputs.flatMap((entry) => entry?.sources ?? []),
				]),
			],
			complete:
				context.complete &&
				pendingInput.complete &&
				mediaInputs.every((entry) => entry?.complete),
		},
		{ replace: notAdopted },
	);
}
