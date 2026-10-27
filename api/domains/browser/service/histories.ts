import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	CATALOG_LIMIT,
	CATALOG_REQUEST_CHARS,
	CATALOG_STEPS,
	CATALOG_STEP_CHARS,
	CATALOG_TITLE_CHARS,
	HISTORY_VARIABLES,
	type HistoryCatalogEntry,
	type HistoryDelete,
	type HistoryDetail,
	type HistoryForOperator,
	type HistorySummary,
} from "../contracts/history";
import {
	deleteHistory,
	historyActions,
	historySteps,
	historyVariables,
	listHistoryRows,
	ownedHistory,
	type HistoryRow,
} from "../repository";
import { buildSource } from "./history-source";

/** Reads and the delete of histories; the writes of a finished task are in `history-record.ts`. */

const variablesOf = (r: HistoryRow) =>
	historyVariables(r).map(({ name, label }) => ({ name, label }));

export const historySummary = (r: HistoryRow): HistorySummary => ({
	historyId: r.id,
	revision: r.revision,
	title: r.title,
	request: r.request,
	place: r.place,
	variables: variablesOf(r),
	stepCount: historySteps(r).length,
	runCount: r.run_count,
	failureCount: r.failure_count,
	lastOutcome: r.last_outcome,
	hasCommit: r.has_commit === 1,
	lastUsedAt: r.last_used_at,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export const listHistories = (db: Database, owner: string): HistorySummary[] =>
	listHistoryRows(db, owner).map(historySummary);

export function historyDetail(
	db: Database,
	owner: string,
	id: string,
): HistoryDetail {
	const r = ownedHistory(db, id, owner);
	const steps = historySteps(r);
	const actions = historyActions(r);
	return {
		...historySummary(r),
		steps,
		actions,
		source: buildSource({
			title: r.title,
			request: r.request,
			variables: variablesOf(r),
			steps,
			actions,
			updatedAt: r.updated_at,
			runCount: r.run_count,
		}),
	};
}

const clip = (text: string, max: number) => text.slice(0, max);

/** REFERENCE.history: the newest histories, each bounded (spec browser-run-history §6.1). */
export function historyCatalog(
	db: Database,
	owner: string,
): HistoryCatalogEntry[] {
	return listHistoryRows(db, owner, CATALOG_LIMIT).map((r) => ({
		historyId: r.id,
		title: clip(r.title, CATALOG_TITLE_CHARS),
		request: clip(r.request, CATALOG_REQUEST_CHARS),
		place: r.place,
		variables: variablesOf(r).slice(0, HISTORY_VARIABLES),
		steps: historySteps(r)
			.slice(0, CATALOG_STEPS)
			.map((s) => clip(s.label, CATALOG_STEP_CHARS)),
		runs: r.run_count,
		lastOutcome: r.last_outcome,
		lastUsed: new Date(r.last_used_at).toISOString().slice(0, 10),
	}));
}

/** What `browser.page.history` returns: the whole procedure, without the assembled source. */
export function historyForOperator(
	db: Database,
	owner: string,
	id: string,
): HistoryForOperator {
	const r = ownedHistory(db, id, owner);
	return {
		historyId: r.id,
		revision: r.revision,
		title: r.title,
		request: r.request,
		variables: variablesOf(r),
		steps: historySteps(r),
		actions: historyActions(r).map(({ stepLabel, ...a }) => ({
			...a,
			...(stepLabel ? { step: stepLabel } : {}),
		})),
	};
}

/** What the service offers the screen: the list, one history with its source, and the delete. */
export const createHistoryApi = (store: SqliteStore) => ({
	listHistories: (owner: string) =>
		store.read((db) => listHistories(db, owner)),
	historyDetail: (owner: string, id: string) =>
		store.read((db) => historyDetail(db, owner, id)),
	deleteHistoryInTransaction: removeHistory,
});

/** The screen's delete at the revision it showed; a history that changed since is not deleted. */
export function removeHistory(
	db: Database,
	owner: string,
	input: HistoryDelete,
) {
	const r = ownedHistory(db, input.historyId, owner);
	if (r.revision !== input.expectedRevision)
		throw new Error("browser_history_conflict");
	deleteHistory(db, r.id);
	return { historyId: r.id };
}
