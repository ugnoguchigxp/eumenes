import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	appDigest,
	checkStorageUpgrade,
	createAppStorageFiles,
	eraseAppInTransaction,
	prepareAppStorage,
	type AppDevelopment,
	type AppDraft,
	type PendingSave,
	type RecordRequest,
} from "../../domains/app-development";
import { compileJsonSchemaSubset } from "../../domains/capabilities";
import type { QueueService } from "../../domains/queue";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { AppWorkflowControls } from "./app-development-adapter";

type App = NonNullable<ReturnType<AppDevelopment["app"]>>;
const kind = "app-development.storage";
const payload = z.strictObject({ appId: z.uuid(), operationId: z.uuid() });
const pending = (state: string | undefined) =>
	state === "initializing" || state === "deleting";
const safeError = (error: unknown, fallback: string) =>
	error instanceof Error && /^app_storage_[a-z_]+$/.test(error.message)
		? error.message
		: fallback;
export const storagePlan = (draft: AppDraft | null | undefined) =>
	draft?.storage
		? prepareAppStorage(draft.storage, draft.schemas, compileJsonSchemaSubset)
		: null;
export const deletionDigest = (app: App) =>
	appDigest([
		"delete",
		app.appId,
		app.revision,
		app.digest,
		!!app.draft.storage,
	]);

export function createAppStorageRuntime(deps: {
	store: SqliteStore;
	queue: QueueService;
	apps: AppDevelopment;
	root: string;
	workflow(): Pick<AppWorkflowControls, "stopForDeletion">;
	publish(db: Database, operationId: string, save: PendingSave): App;
	changed?(): void;
}) {
	const { apps, store, queue } = deps;
	const { scope, storage } = apps;
	const files = createAppStorageFiles(deps.root, compileJsonSchemaSubset);
	function enqueue(
		db: Database,
		appId: string,
		operationId: string,
		retry?: string,
	) {
		return queue.enqueueInTransaction(db, {
			scope,
			kind,
			payload: { appId, operationId },
			subjectRef: appId,
			dedupeKey: retry ? `${operationId}:${retry}` : operationId,
			lane: "background",
			concurrencyKey: `app-storage:${appId}`,
			maxAttempts: 3,
		}).job.id;
	}
	function records(
		db: Database,
		app: App,
		collectionId: string,
		request: RecordRequest,
		operationId = "",
	) {
		const row = storage.get(db, app.appId);
		if (!row?.storageId || row.state !== "active")
			throw new Error("app_storage_unavailable");
		const collection = storagePlan(app.draft)?.collections.find(
			({ id }) => id === collectionId,
		);
		if (!collection) throw new Error("app_storage_collection_not_found");
		return files.records(
			row.storageId,
			row.storageRevision,
			collection,
			request,
			operationId,
			appDigest([app.appId, app.revision, collectionId, request]),
		);
	}
	queue.registerHandler({
		kind,
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const entry = storage.get(db, claim.payload.appId);
			if (
				claim.scope !== scope ||
				!entry ||
				!pending(entry.state) ||
				entry.jobId !== claim.jobId ||
				entry.operationId !== claim.payload.operationId
			)
				return { status: "stale", reason: "app_operation_inactive" };
			return { status: "ready", input: entry };
		},
		async execute(entry, { signal }) {
			signal.throwIfAborted();
			try {
				if (
					entry.state === "initializing" &&
					entry.storageId &&
					entry.saveJson
				) {
					const save = JSON.parse(entry.saveJson) as PendingSave;
					await files.initialize(
						entry.storageId,
						entry.storageRevision,
						entry.storageRevision + 1,
						save.plan,
					);
				} else if (entry.state === "deleting" && entry.storageId) {
					files.remove(entry.storageId);
				}
				return null;
			} catch (error) {
				return safeError(
					error,
					entry.state === "deleting"
						? "app_storage_delete_failed"
						: "app_storage_setup_failed",
				);
			}
		},
		settleInTransaction(db, claim, _input, outcome) {
			const entry = storage.get(db, claim.payload.appId);
			if (!entry || entry.jobId !== claim.jobId || !pending(entry.state))
				return "stale";
			if (outcome.type === "retry" || outcome.type === "interrupted")
				return "applied";
			const error =
				outcome.type === "success" ? outcome.result : "app_storage_job_failed";
			if (error) {
				storage.error(db, entry, error);
				return { status: "failed", errorCode: error };
			}
			db.run("SAVEPOINT app_storage_publish");
			try {
				if (
					entry.state === "initializing" &&
					entry.operationId &&
					entry.saveJson
				) {
					deps.publish(
						db,
						entry.operationId,
						JSON.parse(entry.saveJson) as PendingSave,
					);
				} else if (entry.state === "deleting" && entry.operationId) {
					eraseAppInTransaction(db, scope, entry.appId);
				} else {
					throw new Error("app_storage_job_invalid");
				}
				storage.complete(db, entry);
				db.run("RELEASE app_storage_publish");
				return "applied";
			} catch (error) {
				db.run("ROLLBACK TO app_storage_publish");
				db.run("RELEASE app_storage_publish");
				const code = safeError(error, "app_storage_publication_failed");
				storage.error(db, entry, code);
				return { status: "failed", errorCode: code };
			}
		},
		cancelInTransaction(db, claim) {
			const entry = storage.get(db, claim.payload.appId);
			if (entry?.jobId === claim.jobId)
				storage.error(db, entry, "app_storage_job_cancelled");
		},
		afterCommit: deps.changed,
	});
	return {
		records,
		save(db: Database, appId: string, operationId: string, save: PendingSave) {
			storage.stage(
				db,
				appId,
				operationId,
				enqueue(db, appId, operationId),
				save,
			);
			return { state: "initializing", projectId: appId };
		},
		delete(
			db: Database,
			appId: string,
			revision: number,
			digest: string,
			operationId: string,
		) {
			const app = apps.storedApp(db, appId);
			if (!app || app.revision !== revision || deletionDigest(app) !== digest)
				throw new Error("app_revision_conflict");
			const entry = storage.get(db, appId);
			if (entry?.state === "deleting" && entry.errorCode && entry.operationId) {
				storage.resume(
					db,
					entry,
					enqueue(db, appId, entry.operationId, operationId),
				);
				return { state: "deleting" };
			}
			if (entry && entry.state !== "active")
				throw new Error("app_operation_pending");
			deps.workflow().stopForDeletion(db, app);
			storage.stage(db, appId, operationId, enqueue(db, appId, operationId));
			return { state: "deleting", projectId: appId };
		},
		view(db: Database, app: App, page: number) {
			const binding = app.draft.screen?.storage;
			const plan = storagePlan(app.draft);
			if (!plan) return null;
			const collection = plan.collections.find(
				({ id }) => id === binding?.collection,
			);
			if (!collection || !binding) return null;
			const view = {
				collection: collection.id,
				inputs: binding.inputs,
				operations: collection.operations,
				columns: collection.columns.map(({ name, type }) => {
					const field = (
						collection.row.properties as Record<string, { title?: string }>
					)[name];
					return { name, type, label: field?.title?.slice(0, 120) || name };
				}),
			};
			try {
				const result = collection.operations.includes("list")
					? records(db, app, collection.id, { operation: "list", page })
					: { rows: [], page: 0, hasMore: false };
				return { ...view, ...result };
			} catch (error) {
				return {
					...view,
					rows: [],
					page,
					hasMore: false,
					error: safeError(error, "app_storage_read_failed"),
				};
			}
		},
		async recover() {
			await store.write((db) => {
				for (const entry of storage.pending(db)) {
					const job = entry.jobId
						? queue.getInTransaction(db, entry.jobId)
						: null;
					if (
						entry.operationId &&
						(!job || !["queued", "running", "retry_wait"].includes(job.state))
					)
						storage.resume(
							db,
							entry,
							enqueue(db, entry.appId, entry.operationId, crypto.randomUUID()),
						);
				}
			});
			queue.wake();
		},
	};
}

export function storageForSave(
	db: Database,
	apps: AppDevelopment,
	appId: string,
	draft: AppDraft,
) {
	const plan = storagePlan(draft);
	checkStorageUpgrade(
		storagePlan(apps.storedApp(db, appId)?.draft),
		plan,
		appDigest,
	);
	return plan;
}
