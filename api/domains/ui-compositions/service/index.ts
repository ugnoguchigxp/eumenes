import type { Database } from "bun:sqlite";
import { limits } from "../contracts";
import { get, list, receipt, revision, work } from "../repository";
import { submitInTransaction } from "./answers";
import { scope, summary } from "./shared";
import { formInTransaction, studioInTransaction } from "./views";
import {
	applyDraftInTransaction,
	beginTurnInTransaction,
	deleteInTransaction,
	endTurnInTransaction,
	endWorkInTransaction,
	openWorkInTransaction,
	saveInTransaction,
	stepInTransaction,
	workStateInTransaction,
} from "./work";

export type { Caller } from "./shared";

export function createUiCompositions() {
	return {
		openWorkInTransaction,
		workStateInTransaction,
		beginTurnInTransaction,
		endTurnInTransaction,
		endWorkInTransaction,
		applyDraftInTransaction,
		stepInTransaction,
		saveInTransaction,
		deleteInTransaction,
		submitInTransaction,
		studioInTransaction,
		formInTransaction,
		/** The scope's revision: any change a screen shows advances it. */
		revisionInTransaction: (db: Database) => revision(db, scope),
		/** Saved compositions, newest first. */
		listInTransaction: (db: Database, limit: number = limits.history) =>
			list(db, scope, limit).map(summary),
		/** Whether a saved composition of this scope exists (any, not only the offered choices). */
		hasSavedInTransaction: (db: Database, id: string) =>
			get(db, id)?.scope === scope,
		/** The dialogue session that owns a work, or null once the work ended. */
		sessionOfWorkInTransaction: (db: Database, workRef: string) =>
			work(db, workRef)?.session_id ?? null,
		receiptInTransaction: (db: Database, id: string) =>
			receipt(db, id)?.receipt ?? null,
	};
}
export type UiCompositionsService = ReturnType<typeof createUiCompositions>;
