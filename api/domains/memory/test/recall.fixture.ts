import type { MemoryService } from "../service";

/** The read tool's read of everything: no query, nothing left out, tendencies included. */
export const readEverything = (memory: MemoryService) =>
	memory.recall({
		text: "",
		limit: 21,
		shown: new Set(),
		omitShown: false,
		minScore: 0,
	});
