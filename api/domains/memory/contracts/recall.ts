/** The memory's ranked recall and the input budget (spec/.archived/memory-recall-implementation-2026-11-23.md §2.1). */

export type MemoryRecallInput = {
	/** The user's utterance, or read_memory's query. Empty means every record. */
	text: string;
	/** How many to return (1-21). */
	limit: number;
	/** The ids of the records in the always-on section. */
	shown: ReadonlySet<string>;
	/** true: leave the shown records out. false: keep them, marked inProfile. */
	omitShown: boolean;
	/** When text is not empty, records scoring at or below this are left out. read_memory uses 0. */
	minScore: number;
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
};
