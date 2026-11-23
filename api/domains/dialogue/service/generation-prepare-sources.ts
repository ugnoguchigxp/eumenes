import type { Database } from "bun:sqlite";
import { backgroundInput } from "./background-input";
import type { DialogueDeps } from "./context";
import type { ConversationPrefix } from "./conversation-input";
import { workOfRun } from "../repository/work";
import { workContextInput } from "./work-context-input";

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
		media: ReadonlyArray<{ workId: string }>;
		notAdopted: boolean;
	},
) {
	const memory = deps.memory;
	if (!memory?.referenceInputs) return;
	const context = backgroundInput(deps, tx, conversationId, prefix);
	const pendingInput = memory.referenceInputs.captureInTransaction(tx, {
		messageIds: [...pendingIds],
	});
	const mediaInputs = media.map(({ workId }) =>
		workContextInput(deps, tx, workId, "image-observation"),
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
		// An already committed work item still inherits the sources of the attempt that created it.
		{ replace: notAdopted && workOfRun(tx, runId).length === 0 },
	);
}
