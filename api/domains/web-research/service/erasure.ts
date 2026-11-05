import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import { byId } from "../repository";

/** Caller-owned deliveries are removed only after their erasure committed. */
export function createWebErasure(
	store: SqliteStore,
	queue: QueueService,
	forgetDelivery: (id: string) => void,
) {
	const forgotten = new Set<string>();
	function cancelInTransaction(db: Database, id: string, reason: string) {
		const run = byId(db, id);
		if (!run) return [];
		queue.cancelInTransaction(db, run.job_id, reason);
		return [run.job_id];
	}
	return {
		cancelInTransaction,
		forgetInTransaction(db: Database, id: string) {
			const jobs = cancelInTransaction(db, id, "source_forgotten");
			db.query("DELETE FROM web_research_runs WHERE id=?").run(id);
			forgotten.add(id);
			return jobs;
		},
		flushForgotten() {
			for (const id of forgotten)
				if (!store.read((db) => byId(db, id))) forgetDelivery(id);
			forgotten.clear();
		},
	};
}
