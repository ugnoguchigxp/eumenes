import type { Database } from "bun:sqlite";
import type {
	AppDevelopment,
	PendingSave,
	createAppStorageFiles,
} from "../../domains/app-development";
import type { QueueService } from "../../domains/queue";

export type SaveTicket = {
	appId: string;
	operationId: string;
	stateRevision: number;
	digest: string;
};
export type StorageMode = "save" | "reopen";

export function createSaveRecovery(deps: {
	apps: AppDevelopment;
	queue: QueueService;
	enqueue(
		db: Database,
		appId: string,
		operationId: string,
		requestId: string,
		mode: StorageMode,
	): string;
}) {
	const { apps, queue } = deps;
	function admit(
		db: Database,
		input: SaveTicket,
		requestId: string,
		mode: StorageMode,
	) {
		const entry = apps.storage.get(db, input.appId);
		if (
			entry?.state !== "initializing" ||
			!entry.errorCode ||
			!entry.saveJson ||
			entry.operationId !== input.operationId ||
			entry.stateRevision !== input.stateRevision ||
			(mode === "save" && entry.reopening)
		)
			throw new Error("app_storage_retry_conflict");
		const save = JSON.parse(entry.saveJson) as PendingSave;
		const work = apps.draft(db, save.workRef);
		if (
			save.digest !== input.digest ||
			work.appId !== input.appId ||
			work.busy ||
			(mode === "save" &&
				(work.revision !== save.expectedRevision ||
					work.savedRevision !== save.expectedSavedRevision))
		)
			throw new Error("revision_conflict");
		const job = entry.jobId ? queue.getInTransaction(db, entry.jobId) : null;
		if (job && ["queued", "running", "retry_wait"].includes(job.state))
			throw new Error("app_operation_pending");
		apps.storage.resume(
			db,
			entry,
			deps.enqueue(db, input.appId, input.operationId, requestId, mode),
			mode === "reopen",
		);
		return {
			state: mode === "reopen" ? "reopening" : "initializing",
			projectId: input.appId,
		};
	}
	return {
		retry: (db: Database, input: SaveTicket, requestId: string) =>
			admit(db, input, requestId, "save"),
		reopen: (db: Database, input: SaveTicket, requestId: string) =>
			admit(db, input, requestId, "reopen"),
	};
}

export function reopenStorage(
	files: ReturnType<typeof createAppStorageFiles>,
	entry: NonNullable<ReturnType<AppDevelopment["storage"]["get"]>>,
	published: boolean,
) {
	if (!entry.storageId || !entry.saveJson)
		throw new Error("app_storage_retry_conflict");
	const revision = files.preparedRevision(
		entry.storageId,
		entry.storageRevision,
	);
	if (!published) files.remove(entry.storageId);
	return {
		kind: "reopened" as const,
		revision: published ? revision : 0,
		keepStorage: published,
	};
}
