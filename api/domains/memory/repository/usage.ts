import type { Database } from "bun:sqlite";
/** Removes receipts that reference any of the given items, in one pass over the (pruned, bounded) table. */
export function purgeUsageFor(db: Database, itemIds: Iterable<string>) {
	const targets = new Set(itemIds);
	if (targets.size === 0) return;
	const rows = db
		.query("SELECT run_id, item_ids FROM memory_usage")
		.all() as Array<{
		run_id: string;
		item_ids: string;
	}>;
	const remove = db.query("DELETE FROM memory_usage WHERE run_id = ?");
	for (const row of rows) {
		const ids = JSON.parse(row.item_ids) as string[];
		if (ids.some((id) => targets.has(id))) remove.run(row.run_id);
	}
}

export function deleteUsage(db: Database, runId: string) {
	db.query("DELETE FROM memory_usage WHERE run_id = ?").run(runId);
}
