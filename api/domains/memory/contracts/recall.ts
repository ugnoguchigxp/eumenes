/** The memory's ranked recall and the input budget (spec/memory-recall-implementation-2026-11-23.md §2.1). */

export type MemoryRecallInput = {
	/** The user's utterance, or read_memory's query. Empty means every record. */
	text: string;
	/** How many to return (1-21). */
	limit: number;
	/** The ids of the records in the always-on section. */
	shown: ReadonlySet<string>;
	/** true: leave the shown records out. false: keep them, marked inProfile. */
	omitShown: boolean;
	/** Attach the expired versions (a correction's old values). */
	withPrevious: boolean;
	/** When text is not empty, records scoring at or below this are left out. read_memory uses 0. */
	minScore: number;
	/** host: suppressed records are left out, and sensitive or about-other records come only when direct. tool: all. */
	audience: "tool" | "host";
};

export type MemoryRecalled = {
	id: string;
	revision: number;
	kind: string;
	text: string;
	source: "user_said" | "inferred" | "observed";
	negated?: true;
	suppressed?: true;
	sensitive?: true;
	aboutOther?: true;
	since?: string;
	until?: string;
	inProfile?: true;
	/** 0 when text is empty. */
	score: number;
	/** One of the query's words (two characters or more) appears as is in the record's text. */
	direct: boolean;
	/** With withPrevious: the expired versions of the same matter, newest first, at most 2. until: the day it expired (Asia/Tokyo, YYYY-MM-DD). */
	previous?: { text: string; until: string }[];
};

export type MemoryRecallResult = {
	/** Records and tendencies in force. */
	total: number;
	/** How many matched, before the limit. */
	matched: number;
	items: MemoryRecalled[];
};

export type MemoryInputBudget = {
	/** The always-on section `## Memory`, in tokens. */
	alwaysTokens: number;
	/** responses: constraints and preferences. leanings: + habits. facts: + the user's own facts. */
	alwaysScope: "responses" | "leanings" | "facts";
	/** Whether the per-turn section `## Recall` is shown. */
	recallEnabled: boolean;
	recallTokens: number;
	recallItems: number;
};
