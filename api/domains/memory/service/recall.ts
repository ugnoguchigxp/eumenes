import type { Database } from "bun:sqlite";
import { readMarksOf } from "../repository";
import type {
	MemoryRecallInput,
	MemoryRecalled,
	MemoryRecallResult,
} from "../contracts/recall";
import type { ContextWindowStore } from "./context-window";
import type { ProfileItem } from "./profile";
import { queryTerms, scoreOf } from "./recall-score";

const MAX_LIMIT = 21;

/**
 * The memory's ranked read (spec/memory-recall-implementation-2026-11-23.md section 2.1): the current records and
 * tendencies the query matches, best first, with what the input shows already left out or marked. The work of
 * SQLite and code alone: no model, no embedding. Reading changes nothing.
 */
export function createRecall(deps: { windows: ContextWindowStore }) {
	const { windows } = deps;

	function recallInTransaction(
		db: Database,
		input: MemoryRecallInput,
	): MemoryRecallResult {
		const { items, docs } = windows.currentItemsInTransaction(db);
		const terms = queryTerms(input.text);
		// A query of words that read as nothing (a filler) matches nothing; only an empty one lists everything.
		const ranked = input.text.trim() !== "";
		const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(input.limit)));
		const matched: { item: ProfileItem; score: number }[] = [];
		for (const item of items) {
			const shown = input.shown.has(item.id);
			if (shown && input.omitShown) continue;
			const score = ranked ? scoreOf(terms, docs.get(item.id) ?? "") : 0;
			if (ranked && score <= input.minScore) continue;
			matched.push({ item, score });
		}
		const tendency = (item: ProfileItem) => Number(item.kind === "tendency");
		matched.sort(
			(a, b) =>
				(ranked ? b.score - a.score : tendency(a.item) - tendency(b.item)) ||
				b.item.newness - a.item.newness ||
				(a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
		);
		const picked = matched.slice(0, limit);
		return {
			total: items.length,
			matched: matched.length,
			items: picked.map(({ item, score }): MemoryRecalled => ({
				id: item.id,
				revision: item.revision,
				kind: item.kind,
				text: item.text,
				source: item.source,
				...(item.negated ? { negated: true as const } : {}),
				...(item.suppressed ? { suppressed: true as const } : {}),
				...(item.sensitive ? { sensitive: true as const } : {}),
				...(item.aboutOther ? { aboutOther: true as const } : {}),
				...(item.since ? { since: item.since } : {}),
				...(item.until ? { until: item.until } : {}),
				...(input.shown.has(item.id) ? { inProfile: true as const } : {}),
				score,
			})),
		};
	}

	function marksInTransaction(
		db: Database,
		itemIds: readonly string[],
	): ReadonlyMap<string, { sensitive?: true; aboutOther?: true }> {
		const marks = new Map<string, { sensitive?: true; aboutOther?: true }>();
		for (const [id, mark] of readMarksOf(db, itemIds))
			if (mark.sensitive || mark.aboutOther)
				marks.set(id, {
					...(mark.sensitive ? { sensitive: true as const } : {}),
					...(mark.aboutOther ? { aboutOther: true as const } : {}),
				});
		return marks;
	}

	return {
		recallInTransaction,
		marksInTransaction,
	};
}
