import type { Database } from "bun:sqlite";
import { listState, type StateItem } from "eumenes-memory/sqlite";

/** The host reads every page synchronously in the same read/write transaction, never a silent first page. */
export function listAllState(
	db: Database,
	input: Parameters<typeof listState>[1],
): ReturnType<typeof listState> {
	const items: StateItem[] = [];
	let after = input.after;
	for (;;) {
		const result = listState(db, { ...input, ...(after ? { after } : {}) });
		if (result.status !== "ok") return result;
		items.push(...result.items);
		if (!result.nextCursor) return { status: "ok", items };
		after = result.nextCursor;
	}
}
