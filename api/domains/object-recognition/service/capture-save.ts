import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { RecognitionRecord } from "../contracts";
import { owned, record, row, setCaptureSave } from "../repository";

type Enqueue = (db: Database, input: { id: string; owner: string }) => void;
export type CaptureSaveDependencies = {
	captureSaveInTransaction?: Enqueue;
	captureResumeInTransaction?: Enqueue;
};
export function enqueueCaptureSave(
	db: Database,
	original: RecognitionRecord,
	owner: string,
	enqueue?: Enqueue,
) {
	if (
		!enqueue ||
		original.origin === "file" ||
		!original.mime.startsWith("image/")
	)
		return original;
	let state: "queued" | "failed" = "queued";
	db.exec("SAVEPOINT capture_save_enqueue");
	try {
		enqueue(db, { id: original.id, owner });
		db.exec("RELEASE capture_save_enqueue");
	} catch {
		db.exec("ROLLBACK TO capture_save_enqueue");
		db.exec("RELEASE capture_save_enqueue");
		state = "failed";
	}
	return setCaptureSave(db, original.id, state);
}
export function setCaptureSaveInTransaction(
	db: Database,
	owner: string,
	id: string,
	state: NonNullable<RecognitionRecord["captureSave"]>,
) {
	const r = row(db, id);
	if (!r || r.owner !== owner || !record(r).captureSave) return false;
	setCaptureSave(db, id, state);
	return true;
}

export function captureSaveOperations(store: SqliteStore, resume?: Enqueue) {
	return {
		setCaptureSaveInTransaction,
		resumeCaptureSave: (owner: string, id: string) =>
			store.write((db) => {
				const current = record(owned(db, id, owner));
				if (current.captureSave !== "unconfirmed" || !resume)
					throw new Error("recognition_not_ready");
				resume(db, { id, owner });
				return setCaptureSave(db, id, "queued");
			}),
	};
}
