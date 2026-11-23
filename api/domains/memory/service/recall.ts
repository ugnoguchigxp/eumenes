import type { Database } from "bun:sqlite";
import {
	listStateByTime,
	readStateFact,
	type StateItem,
} from "eumenes-memory/sqlite";
import { readMarksOf } from "../repository";
import type {
	MemoryRecallInput,
	MemoryRecalled,
	MemoryRecallResult,
} from "../contracts/recall";
import type { ContextWindowStore } from "./context-window";
import { listAllState } from "./state-snapshot";
import { tokyoDay, type ProfileItem } from "./profile";
import { isDirect, normalizeText, queryTerms, scoreOf } from "./recall-score";
import type { CurationDeps } from "./curation-shared";

/** How many expired versions of the same matter a record carries. */
const PREVIOUS_LIMIT = 2;
const MAX_LIMIT = 21;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The memory's ranked read (spec/memory-recall-implementation-2026-11-23.md section 2.1): the current records and
 * tendencies the query matches, best first, with what the input shows already left out or marked. The work of
 * SQLite and code alone: no model, no embedding. Reading changes nothing.
 */
export function createRecall(deps: {
	windows: ContextWindowStore;
	scoped: CurationDeps["scoped"];
}) {
	const { windows, scoped } = deps;

	/**
	 * The expired versions of the records' matters (a correction's old values), newest first. Only the matters of the
	 * records picked are read: their versions by `readStateFact`, and the day each stopped holding by one walk of the
	 * time axis that ends when the versions needed are found.
	 */
	function previousOf(
		db: Database,
		picked: readonly ProfileItem[],
	): Map<string, { text: string; until: string }[]> {
		const found = new Map<string, { text: string; until: string }[]>();
		const matters = new Map<string, string[]>();
		for (const item of picked) {
			if (item.kind === "tendency") continue;
			const fact = readStateFact(db, {
				...scoped(db, "memory.read"),
				itemId: item.id,
			});
			if (fact.status !== "ok") continue;
			const others = fact.itemIds.filter((id) => id !== item.id);
			if (others.length > 0) matters.set(item.id, others);
		}
		if (matters.size === 0) return found;
		const versions = new Map<string, StateItem>();
		const wanted = [...new Set([...matters.values()].flat())];
		for (let i = 0; i < wanted.length; i += 1000) {
			const listed = listAllState(db, {
				...scoped(db, "memory.read"),
				includeInactive: true,
				itemIds: wanted.slice(i, i + 1000),
			});
			if (listed.status !== "ok") throw new Error("memory_blocked");
			for (const version of listed.items) versions.set(version.itemId, version);
		}
		// The newest two expired versions of each matter that read differently from the record.
		const chosen = new Map<string, StateItem[]>();
		for (const item of picked) {
			const current = normalizeText(collapse(item.text));
			const older = (matters.get(item.id) ?? [])
				.flatMap((id) => versions.get(id) ?? [])
				.filter(
					(version) =>
						version.status === "superseded" &&
						normalizeText(collapse(version.value.text)) !== current,
				)
				.sort((a, b) => b.createdSeq - a.createdSeq)
				.slice(0, PREVIOUS_LIMIT);
			if (older.length > 0) chosen.set(item.id, older);
		}
		const needed = new Set([...chosen.values()].flat().map((v) => v.itemId));
		if (needed.size === 0) return found;
		const expiredAt = new Map<string, number>();
		let after = {
			createdSeq:
				Math.min(...[...chosen.values()].flat().map((v) => v.createdSeq)) - 1,
			itemId: "0",
		};
		while (expiredAt.size < needed.size) {
			const listed = listStateByTime(db, {
				...scoped(db, "memory.read"),
				after,
				limit: 200,
			});
			if (listed.status !== "ok") throw new Error("memory_blocked");
			for (const version of listed.items)
				if (needed.has(version.itemId) && version.supersededAtMs !== null)
					expiredAt.set(version.itemId, version.supersededAtMs);
			if (!listed.nextCursor) break;
			after = listed.nextCursor;
		}
		for (const [id, older] of chosen) {
			const previous = older
				.flatMap((version) => {
					const at = expiredAt.get(version.itemId);
					return at === undefined
						? []
						: [{ text: collapse(version.value.text), at }];
				})
				.sort((a, b) => b.at - a.at)
				.map(({ text, at }) => ({ text, until: tokyoDay(at) }));
			if (previous.length > 0) found.set(id, previous);
		}
		return found;
	}

	function recallInTransaction(
		db: Database,
		input: MemoryRecallInput,
	): MemoryRecallResult {
		const { items, docs } = windows.currentItemsInTransaction(db);
		const terms = queryTerms(input.text);
		// A query of words that read as nothing (a filler) matches nothing; only an empty one lists everything.
		const ranked = input.text.trim() !== "";
		const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(input.limit)));
		const matched: { item: ProfileItem; score: number; direct: boolean }[] = [];
		for (const item of items) {
			const shown = input.shown.has(item.id);
			if (shown && input.omitShown) continue;
			const score = ranked ? scoreOf(terms, docs.get(item.id) ?? "") : 0;
			if (ranked && score <= input.minScore) continue;
			const direct = ranked && isDirect(terms, item.text);
			if (input.audience === "host") {
				if (item.suppressed) continue;
				if ((item.sensitive || item.aboutOther) && !direct) continue;
			}
			matched.push({ item, score, direct });
		}
		const tendency = (item: ProfileItem) => Number(item.kind === "tendency");
		matched.sort(
			(a, b) =>
				(ranked ? b.score - a.score : tendency(a.item) - tendency(b.item)) ||
				b.item.newness - a.item.newness ||
				(a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
		);
		const picked = matched.slice(0, limit);
		const previous = input.withPrevious
			? previousOf(
					db,
					picked.map((entry) => entry.item),
				)
			: new Map<string, { text: string; until: string }[]>();
		return {
			total: items.length,
			matched: matched.length,
			items: picked.map(({ item, score, direct }): MemoryRecalled => {
				const older = previous.get(item.id);
				return {
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
					direct,
					...(older ? { previous: older } : {}),
				};
			}),
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
