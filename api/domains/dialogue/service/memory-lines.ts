import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	keepOrder,
	type MemoryInputBudget,
	type ProfileItem,
	type WindowSnapshot,
} from "../../memory";
import type { DialogueDeps } from "./context";
import { INPUT_HEADINGS } from "./input-text";
import { memoryItemLine } from "./result-text";

/** What `## Memory` is drawn within: the memory's setting of its bound and of the kinds it holds. */
export type AlwaysBudget = Pick<
	MemoryInputBudget,
	"alwaysTokens" | "alwaysScope"
>;

/** The kinds each scope of `## Memory` holds, widest last. */
const ALWAYS_KINDS: Record<AlwaysBudget["alwaysScope"], ReadonlySet<string>> = {
	responses: new Set(["constraint", "preference"]),
	leanings: new Set(["constraint", "preference", "habit"]),
	facts: new Set(["constraint", "preference", "habit", "personal_fact"]),
};

/** Without memory nothing is shown, so no bound is read: the same text as an empty window. */
const NO_MEMORY_BUDGET: AlwaysBudget = {
	alwaysTokens: 0,
	alwaysScope: "responses",
};

/** The bound and scope of `## Memory` as the memory sets them now. */
export const alwaysBudgetInTransaction = (
	deps: DialogueDeps,
	tx: Database,
): AlwaysBudget =>
	deps.memory?.inputBudgetInTransaction(tx) ?? NO_MEMORY_BUDGET;

/** What `## Memory` shows of a window: a cut is placed when it would show something else. */
export const memoryDigestOf = (
	window: WindowSnapshot | null,
	budget: AlwaysBudget,
) =>
	sha256Hex(memoryLines(window?.profile.items ?? [], budget).lines.join("\n"));

/** What a reference is measured as while the lines are fitted: wide enough for any number the memory hands out. */
const REF_WIDTH = "m00000";

/**
 * The user's own statements of the published profile, of the kinds the scope holds, within the bound (the short
 * references count in it), in its published order, and the items they are. An item marked sensitive or about another
 * person, or one marked not to be brought up, is not here: it is read when it is asked for. `refs` are the references
 * the memory handed out for them (item id -> `m<n>`): a line carries its own, none without. The fit measures every
 * line with a reference of full width, so the same items are kept whatever numbers they were given (the cut's digest
 * and the text drawn agree).
 */
export function memoryLines(
	items: readonly ProfileItem[],
	budget: AlwaysBudget,
	refs?: ReadonlyMap<string, string>,
): {
	lines: string[];
	ids: string[];
	shown: ProfileItem[];
} {
	const kinds = ALWAYS_KINDS[budget.alwaysScope];
	// The user's own words only: an inference or an observation read as a fact steers the reply (C4).
	const held = items.filter(
		(item) =>
			kinds.has(item.kind) &&
			item.source === "user_said" &&
			!item.sensitive &&
			!item.aboutOther &&
			!item.suppressed,
	);
	const lineOf = (item: ProfileItem, ref: string | undefined) =>
		memoryItemLine({
			...(ref ? { ref } : {}),
			text: item.text,
			negated: item.negated,
			source: item.source,
			...(item.since ? { since: item.since } : {}),
			...(item.until ? { until: item.until } : {}),
		});
	// Measured as the section reads (its heading and lines together), with every reference at full width. The
	// estimate rounds once over the whole text, so each part is taken at four times its unrounded size (a text
	// repeated four times is exactly that) and the sum is compared with four times the bound.
	const quarters = (text: string) => estimateTextTokens(text.repeat(4));
	const lineBreak = quarters("\n");
	let used = quarters(INPUT_HEADINGS.memory);
	const kept = new Set<string>();
	for (const item of keepOrder(held)) {
		const cost = lineBreak + quarters(lineOf(item, REF_WIDTH));
		if (used + cost > 4 * budget.alwaysTokens) continue;
		kept.add(item.id);
		used += cost;
	}
	const shown = held.filter((item) => kept.has(item.id));
	return {
		lines: shown.map((item) => lineOf(item, refs?.get(item.id))),
		ids: shown.map((item) => item.id),
		shown,
	};
}

/**
 * The items of the window whose sources the agency still holds current. The sources of all of them are captured once
 * (the memory builds its records for each capture): when that whole is current so is each item, and only a window
 * with something stale in it is judged item by item.
 */
export function currentProfileItems(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	items: readonly ProfileItem[],
): readonly ProfileItem[] {
	const agency = deps.agency;
	if (!agency?.isCurrentInputInTransaction || !items.length) return items;
	const current = (list: readonly ProfileItem[]) =>
		agency.isCurrentInputInTransaction!(
			tx,
			deps.memory?.referenceInputs.captureInTransaction(tx, {
				itemIds: list.map((item) => item.id),
				itemRevisions: Object.fromEntries(
					list.map((item) => [item.id, item.revision]),
				),
			}) ?? {
				sources: list.map((item) => `memory:${item.id}`),
				complete: false,
			},
			conversationId,
		);
	return current(items) ? items : items.filter((item) => current([item]));
}
