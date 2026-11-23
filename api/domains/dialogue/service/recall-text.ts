import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import {
	touchesSuppressedTerm,
	type MemoryInputBudget,
	type MemoryRecalled,
} from "../../memory";
import type { PlanItem } from "../../continuity";
import type { DialogueDeps } from "./context";
import { INPUT_HEADINGS, lineText } from "./input-text";
import { memoryItemLine } from "./result-text";
import { planNotes, planText, suppressedTerms } from "./state-plans";

/**
 * The score a record must pass to be shown by `## Recall` (the memory ranks by the share of the question's character
 * pairs a record holds; a sentence-long question scores a record that merely shares a word low). A trial value:
 * it is set by comparing the answers with and without the section (implementation spec section 10).
 */
export const RECALL_MIN_SCORE = 0.3;

/** The most records one `## Recall` asks the memory for (the memory's own most). */
const MOST_RECORDS = 21;

/** What a reference is measured as while the lines are fitted: wide enough for any number the memory hands out. */
const REF_WIDTH = "m00000";

type Line = {
	/** The record the line's reference names, when it has one. */
	item?: MemoryRecalled;
	planId?: string;
	render: (ref: string | undefined) => string;
};

/** A tendency has no reference: it reads as an estimate, not as something the user may correct or forget. */
const referable = (item: MemoryRecalled | undefined): item is MemoryRecalled =>
	!!item && !item.id.startsWith("tendency:") && item.suppressed !== true;

const withRef = (ref: string | undefined) => (ref ? `${ref} ` : "");

/**
 * The records this turn's words bring to mind, as the lines of `## Recall` (without its heading): what the memory
 * holds that relates (`記憶`, the ones `## Memory` does not show already), what an item was before it was corrected
 * (`以前`), the plans (`予定`, the ones `## State` does not show already) and the open questions about a record shown
 * here (`食い違い`). Material for the reply, never an instruction. A line that names a topic the user asked not to be
 * brought up is not here; nothing at all when the words are empty or the suppressions cannot be read. The lines
 * that fit `recallTokens` are kept, in this order, and only those get a short reference (inside the caller's
 * writer transaction: `refOf` hands them out). Nothing is saved: the section is drawn again by every turn.
 */
export function recallLinesInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: {
		conversationId: string;
		utterances: readonly string[];
		shownMemoryIds: ReadonlySet<string>;
		shownPlanIds: ReadonlySet<string>;
		budget: Pick<MemoryInputBudget, "recallTokens" | "recallItems">;
		/** The memory's short references for these records (`memoryFound` hands them out the same way). */
		refOf: (
			items: readonly { itemId: string; revision: number }[],
		) => ReadonlyMap<string, string>;
	},
): { lines: string[]; memoryItemIds: string[]; planIds: string[] } {
	const none = { lines: [], memoryItemIds: [], planIds: [] };
	const text = input.utterances.join("\n").trim();
	const terms = suppressedTerms(deps, tx);
	if (!deps.memory || !text || terms === null || input.budget.recallItems < 1)
		return none;
	const allowed = (words: string) => !touchesSuppressedTerm(terms, words);
	const recalled = deps.memory.recallInTransaction(tx, {
		text,
		limit: Math.min(input.budget.recallItems, MOST_RECORDS),
		shown: input.shownMemoryIds,
		omitShown: false,
		withPrevious: true,
		minScore: RECALL_MIN_SCORE,
		audience: "host",
	});
	const lines: Line[] = [];
	// What was remembered, except what `## Memory` says already.
	for (const item of recalled.items) {
		if (input.shownMemoryIds.has(item.id) || !allowed(item.text)) continue;
		lines.push({
			item,
			render: (ref) =>
				`- 記憶: ${memoryItemLine({
					...(ref ? { ref } : {}),
					text: item.text,
					negated: item.negated === true,
					source: item.source,
					...(item.since ? { since: item.since } : {}),
					...(item.until ? { until: item.until } : {}),
				}).slice(2)}`,
		});
	}
	// What it was before a correction, for the records shown here and in `## Memory` alike.
	for (const item of recalled.items)
		for (const before of item.previous ?? []) {
			if (!allowed(before.text)) continue;
			lines.push({
				item,
				render: (ref) =>
					`- 以前: ${withRef(ref)}${lineText(before.text)}（${before.until} まで）`,
			});
		}
	const plans = deps.continuity.plans;
	const about = plans
		.searchInTransaction(tx, text)
		.filter(
			(plan) =>
				["plan", "intent"].includes(plan.kind) &&
				!input.shownPlanIds.has(plan.id) &&
				allowed(plan.text),
		)
		.slice(0, input.budget.recallItems);
	for (const plan of about)
		lines.push({
			planId: plan.id,
			render: () => `- 予定: ${planText(plan)}${planNotes(plan)}`,
		});
	// What the memory and an open question about it leave unsettled: both are told, neither is judged.
	const byId = new Map(recalled.items.map((item) => [item.id, item]));
	const open: PlanItem[] = plans.listInTransaction(tx, {
		kinds: ["open_question"],
		states: ["open"],
	});
	for (const plan of open) {
		const linked = plan.memoryItemIds
			.map((id) => byId.get(id))
			.find((item) => !!item);
		if (!linked || !allowed(plan.text)) continue;
		lines.push({
			item: linked,
			planId: plan.id,
			render: (ref) => `- 食い違い: ${withRef(ref)}${planText(plan)}`,
		});
	}

	const refFor = (line: Line, refs: ReadonlyMap<string, string> | null) =>
		referable(line.item)
			? (refs?.get(line.item.id) ?? (refs ? undefined : REF_WIDTH))
			: undefined;
	// Measured as the section reads, with every reference at full width: the numbers do not decide what is kept.
	const tokensOf = (kept: readonly Line[]) =>
		estimateTextTokens(
			[
				INPUT_HEADINGS.recall,
				...kept.map((line) => line.render(refFor(line, null))),
			].join("\n"),
		);
	const kept: Line[] = [];
	for (const line of lines)
		if (tokensOf([...kept, line]) <= input.budget.recallTokens) kept.push(line);
	if (!kept.length) return none;
	const wanted = new Map<string, number>();
	for (const line of kept)
		if (referable(line.item)) wanted.set(line.item.id, line.item.revision);
	const refs = wanted.size
		? input.refOf(
				[...wanted].map(([itemId, revision]) => ({ itemId, revision })),
			)
		: new Map<string, string>();
	return {
		lines: kept.map((line) => line.render(refFor(line, refs))),
		memoryItemIds: [
			...new Set(
				kept.flatMap((line) =>
					line.item && !line.item.id.startsWith("tendency:")
						? [line.item.id]
						: [],
				),
			),
		],
		planIds: [...new Set(kept.flatMap((line) => line.planId ?? []))],
	};
}
