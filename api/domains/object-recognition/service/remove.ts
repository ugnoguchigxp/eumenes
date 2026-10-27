import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import type { createRecognitionAnalyses } from "./analyses";
import { owned, record } from "../repository";
export async function removeRecognition(
	store: SqliteStore,
	queue: QueueService,
	analyses: ReturnType<typeof createRecognitionAnalyses> | null,
	owner: string,
	id: string,
) {
	const jobs = await store.write((db) => {
		const r = owned(db, id, owner);
		const current = record(r);
		if (
			!["completed", "failed", "cancelled"].includes(current.state) ||
			current.captureSave === "queued"
		)
			throw new Error("recognition_not_ready");
		const jobs = analyses?.removeInTransaction(db, id) ?? [];
		db.query("DELETE FROM object_recognition_inputs WHERE id=?").run(id);
		return jobs;
	});
	queue.flushCancellations(jobs);
}
