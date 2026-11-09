import type { Database } from "bun:sqlite";
import type { Migration } from "../../infrastructure/sqlite";
import type { StoragePlan } from "./storage-contract";

export const storageMigration: Migration = {
	id: "app-development/0003-storage-lifecycle",
	after: ["app-development/0002-workflow-web-routes"],
	sql: `
CREATE TABLE app_development_storage (
 scope TEXT NOT NULL, app_id TEXT NOT NULL, storage_id TEXT UNIQUE, storage_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','initializing','deleting','deleted')),
 operation_id TEXT, job_id TEXT, save_json TEXT, error_code TEXT,
 PRIMARY KEY(scope,app_id)
);`,
};

export type PendingSave = {
	workRef: string;
	expectedRevision: number;
	expectedSavedRevision: number;
	digest: string;
	plan: StoragePlan;
};
type Entry = {
	appId: string;
	storageId: string | null;
	storageRevision: number;
	state: "active" | "initializing" | "deleting" | "deleted";
	operationId: string | null;
	jobId: string | null;
	saveJson: string | null;
	errorCode: string | null;
};
const columns = `app_id AS appId, storage_id AS storageId, storage_revision AS storageRevision,
state, operation_id AS operationId, job_id AS jobId, save_json AS saveJson, error_code AS errorCode`;

export function createStorageLifecycle(scope: string) {
	const get = (db: Database, id: string) =>
		db
			.query<Entry, [string, string]>(
				`SELECT ${columns} FROM app_development_storage WHERE scope=? AND app_id=?`,
			)
			.get(scope, id);
	return {
		get,
		available(db: Database, id: string) {
			const entry = get(db, id);
			return !entry || entry.state === "active";
		},
		pending(db: Database) {
			return db
				.query<Entry, [string]>(
					`SELECT ${columns} FROM app_development_storage WHERE scope=? AND state IN ('initializing','deleting')`,
				)
				.all(scope);
		},
		stage(
			db: Database,
			id: string,
			operationId: string,
			jobId: string,
			save?: PendingSave,
		) {
			const prior = get(db, id);
			if (prior && prior.state !== "active")
				throw new Error("app_operation_pending");
			const storageId = prior?.storageId ?? (save ? crypto.randomUUID() : null);
			db.run(
				`INSERT INTO app_development_storage VALUES(?,?,?,?,?,?,?,?,NULL)
ON CONFLICT(scope,app_id) DO UPDATE SET storage_id=excluded.storage_id,state=excluded.state,
operation_id=excluded.operation_id,job_id=excluded.job_id,save_json=excluded.save_json,error_code=NULL`,
				[
					scope,
					id,
					storageId,
					prior?.storageRevision ?? 0,
					save ? "initializing" : "deleting",
					operationId,
					jobId,
					save ? JSON.stringify(save) : null,
				],
			);
		},
		resume(db: Database, entry: Entry, jobId: string) {
			db.run(
				"UPDATE app_development_storage SET job_id=?,error_code=NULL WHERE scope=? AND app_id=? AND operation_id=?",
				[jobId, scope, entry.appId, entry.operationId],
			);
		},
		error(db: Database, entry: Entry, code: string) {
			db.run(
				"UPDATE app_development_storage SET error_code=? WHERE scope=? AND app_id=? AND job_id=?",
				[code, scope, entry.appId, entry.jobId],
			);
		},
		complete(db: Database, entry: Entry) {
			const saving = entry.state === "initializing";
			const result = db.run(
				`UPDATE app_development_storage SET state=?,storage_revision=?,job_id=NULL,save_json=NULL,error_code=NULL
WHERE scope=? AND app_id=? AND job_id=? AND state=?`,
				[
					saving ? "active" : "deleted",
					saving ? entry.storageRevision + 1 : entry.storageRevision,
					scope,
					entry.appId,
					entry.jobId,
					entry.state,
				],
			);
			if (result.changes !== 1) throw new Error("app_operation_changed");
		},
	};
}

export function eraseAppInTransaction(db: Database, scope: string, id: string) {
	db.run("DELETE FROM app_development_works WHERE scope=? AND app_id=?", [
		scope,
		id,
	]);
	db.run("DELETE FROM app_development_versions WHERE scope=? AND app_id=?", [
		scope,
		id,
	]);
	db.run(
		"DELETE FROM app_development_web_routes WHERE scope=? AND workflow_id=?",
		[scope, id],
	);
}
