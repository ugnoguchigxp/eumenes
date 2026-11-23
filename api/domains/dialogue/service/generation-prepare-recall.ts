import type { Database } from "bun:sqlite";
import { backgroundInput } from "./background-input";
import type { DialogueDeps } from "./context";
import type { ConversationPrefix } from "./conversation-input";
import { recallLinesInTransaction } from "./recall-text";
import { planGoalFields } from "./state-plans";
import { workOfRun } from "../repository/work";
import { workContextInput } from "./work-context-input";

/**
 * `## Recall` for the user's words of this turn, or null when it is off (the memory's setting), memory has no window to
 * number references in, or nothing relates. The plans `## State` shows (the routed turn's) are not told again.
 */
export function recallInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: {
		conversationId: string;
		prefix: ConversationPrefix;
		utterances: readonly string[];
	},
) {
	const { memory } = deps;
	const windowKey = input.prefix.refsKey;
	if (!memory || !windowKey) return null;
	const budget = memory.inputBudgetInTransaction(tx);
	if (!budget.recallEnabled) return null;
	const found = recallLinesInTransaction(deps, tx, {
		conversationId: input.conversationId,
		utterances: input.utterances,
		shownMemoryIds: new Set(input.prefix.memoryItemIds),
		shownPlanIds: new Set(planGoalFields(deps, tx).planIds),
		budget,
		// The window of `## Memory`: its numbers go on, an item shown in both keeps its reference.
		refOf: (items) =>
			new Map(
				memory.shortRefs
					.assignInTransaction(tx, {
						conversationId: input.conversationId,
						windowKey,
						items,
					})
					.map((ref) => [ref.itemId, ref.ref]),
			),
	});
	return found.lines.length ? found : null;
}

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
		recalled,
	}: {
		runId: string;
		conversationId: string;
		prefix: ConversationPrefix;
		pendingIds: ReadonlySet<string>;
		media: ReadonlyArray<{ workId: string }>;
		notAdopted: boolean;
		/** The records `## Recall` shows: seen by the reply like those of `## Memory`. */
		recalled: readonly string[];
	},
) {
	const memory = deps.memory;
	if (!memory?.referenceInputs) return;
	const context = backgroundInput(deps, tx, conversationId, prefix);
	const pendingInput = memory.referenceInputs.captureInTransaction(tx, {
		messageIds: [...pendingIds],
	});
	// A forgotten or corrected record the reply saw in `## Recall` expires it as one of `## Memory` does.
	const recallInput = recalled.length
		? memory.referenceInputs.captureInTransaction(tx, { itemIds: recalled })
		: { sources: [], complete: true };
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
					...recallInput.sources,
					...mediaInputs.flatMap((entry) => entry?.sources ?? []),
				]),
			],
			complete:
				context.complete &&
				pendingInput.complete &&
				recallInput.complete &&
				mediaInputs.every((entry) => entry?.complete),
		},
		// An already committed work item still inherits the sources of the attempt that created it.
		{ replace: notAdopted && workOfRun(tx, runId).length === 0 },
	);
}
