import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
	type VectorSpace,
} from "../../capabilities";
import {
	SELECTION_RETENTION_MS,
	type PastSelection,
	type Selection,
	type SelectionAnalysis,
	type SelectionCandidate,
	type SelectionDecision,
	type SelectionOutcome,
} from "../contracts";
import type { SelectionRow } from "../repository";

const log = getLogger("toolchain-history");
const SIMILAR_SCAN = 500;

export function selection(row: SelectionRow): Selection {
	return {
		id: row.id,
		runId: row.run_id,
		conversationId: row.conversation_id,
		utteranceId: row.utterance_id,
		requestId: row.request_id,
		retrieval: row.retrieval,
		candidates: JSON.parse(row.candidates_json),
		historyRefs: JSON.parse(row.history_refs_json),
		decision: row.decision,
		toolchainId: row.toolchain_id,
		toolchainRevisionId: row.toolchain_revision_id,
		functionName: row.function_name,
		request: row.request_text,
		repaired: !!row.repaired,
		...(row.analysis_json ? { analysis: JSON.parse(row.analysis_json) } : {}),
		taskId: row.task_id,
		outcome: row.outcome as SelectionOutcome | null,
		outcomeCode: row.outcome_code,
		recipe: row.recipe,
		durationMs: row.duration_ms,
		createdAt: row.created_at,
		settledAt: row.settled_at,
	};
}
/** What the conversation model was offered, what it chose, and how the run ended. */
export function createSelections(store: SqliteStore, now: () => number) {
	function pruneInTransaction(db: Database) {
		db.query(
			"DELETE FROM toolchain_selections WHERE id IN (SELECT id FROM toolchain_selections WHERE expires_at<=? LIMIT 200)",
		).run(now());
	}
	/** One row per conversation decision; a retried attempt of the same run replaces it. */
	function recordSelectionInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			utteranceId?: string | null;
			requestId?: string | null;
			retrieval: Selection["retrieval"];
			candidates: SelectionCandidate[];
			historyRefs: string[];
			decision: SelectionDecision;
			toolchainId?: string;
			toolchainRevisionId?: string;
			functionName?: string;
			request?: string;
			repaired?: boolean;
			analysis?: SelectionAnalysis;
			query?: { space: VectorSpace; vector: number[] };
			durationMs?: number;
		},
	) {
		pruneInTransaction(db);
		const at = now();
		const id = crypto.randomUUID();
		db.query(
			`INSERT INTO toolchain_selections(id,run_id,conversation_id,utterance_id,request_id,retrieval,candidates_json,history_refs_json,decision,toolchain_id,toolchain_revision_id,function_name,request_text,repaired,analysis_json,duration_ms,query_space,query_vector,created_at,expires_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(run_id) DO UPDATE SET retrieval=excluded.retrieval,candidates_json=excluded.candidates_json,history_refs_json=excluded.history_refs_json,decision=excluded.decision,toolchain_id=excluded.toolchain_id,toolchain_revision_id=excluded.toolchain_revision_id,function_name=excluded.function_name,request_text=excluded.request_text,repaired=excluded.repaired,analysis_json=excluded.analysis_json,duration_ms=excluded.duration_ms,query_space=excluded.query_space,query_vector=excluded.query_vector,task_id=NULL,outcome=NULL,outcome_code=NULL,recipe=NULL,settled_at=NULL`,
		).run(
			id,
			input.runId,
			input.conversationId,
			input.utteranceId ?? null,
			input.requestId ?? null,
			input.retrieval,
			JSON.stringify(input.candidates),
			JSON.stringify(input.historyRefs),
			input.decision,
			input.toolchainId ?? null,
			input.toolchainRevisionId ?? null,
			input.functionName ?? null,
			input.request ?? null,
			input.repaired ? 1 : 0,
			input.analysis ? JSON.stringify(input.analysis) : null,
			input.durationMs ?? null,
			input.query ? vectorSpaceKey(input.query.space) : null,
			input.query ? packVector(input.query.vector) : null,
			at,
			at + SELECTION_RETENTION_MS,
		);
		const saved = db
			.query("SELECT id FROM toolchain_selections WHERE run_id=?")
			.get(input.runId) as { id: string };
		log.info("toolchain.selection_recorded", {
			selectionId: saved.id,
			runId: input.runId,
			decision: input.decision,
			candidateCount: input.candidates.length,
			retrieval: input.retrieval,
			...(input.toolchainId ? { toolchainId: input.toolchainId } : {}),
		});
		return saved.id;
	}
	function linkTaskInTransaction(db: Database, runId: string, taskId: string) {
		db.query("UPDATE toolchain_selections SET task_id=? WHERE run_id=?").run(
			taskId,
			runId,
		);
	}
	/** The end of the run the selection started; the first terminal result wins. */
	function settleSelectionInTransaction(
		db: Database,
		runId: string,
		result: { outcome: SelectionOutcome; code?: string | null },
	) {
		const changed = db
			.query(
				"UPDATE toolchain_selections SET outcome=?,outcome_code=?,settled_at=? WHERE run_id=? AND settled_at IS NULL",
			)
			.run(result.outcome, result.code ?? null, now(), runId).changes;
		if (changed)
			log.info("toolchain.selection_settled", {
				runId,
				outcome: result.outcome,
				...(result.code ? { reason: result.code } : {}),
			});
	}
	function markRecipeInTransaction(
		db: Database,
		runId: string,
		state: "matched" | "missed" | "saved",
	) {
		// "saved" and "matched" are more informative than "missed"; never downgrade.
		db.query(
			"UPDATE toolchain_selections SET recipe=? WHERE run_id=? AND (recipe IS NULL OR recipe='missed' OR ?='saved')",
		).run(state, runId, state);
	}
	/**
	 * Past decisions for similar requests, nearest first: reference data for the conversation
	 * model. Only toolchain decisions on currently active revisions, including failures.
	 */
	function similarSelectionsInTransaction(
		db: Database,
		input: {
			space: VectorSpace;
			vector: number[];
			activeRevisionIds: ReadonlySet<string>;
			excludeRunId?: string;
			limit?: number;
		},
	): PastSelection[] {
		const key = vectorSpaceKey(input.space);
		const rows = db
			.query(
				`SELECT id,run_id,toolchain_revision_id,function_name,request_text,outcome,query_vector FROM toolchain_selections
				 WHERE query_space=? AND decision='toolchain' AND query_vector IS NOT NULL AND expires_at>?
				 ORDER BY created_at DESC LIMIT ?`,
			)
			.all(key, now(), SIMILAR_SCAN) as Array<
			Pick<
				SelectionRow,
				| "id"
				| "run_id"
				| "toolchain_revision_id"
				| "function_name"
				| "request_text"
				| "outcome"
				| "query_vector"
			>
		>;
		return rows
			.filter(
				(r) =>
					r.run_id !== input.excludeRunId &&
					r.toolchain_revision_id &&
					input.activeRevisionIds.has(r.toolchain_revision_id) &&
					r.function_name &&
					r.request_text,
			)
			.map((r) => {
				const v = unpackVector(r.query_vector!);
				return {
					r,
					score:
						v.length === input.vector.length ? dot(v, input.vector) : -Infinity,
				};
			})
			.filter((x) => x.score > 0.8)
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.min(3, input.limit ?? 3))
			.map(({ r }) => ({
				selectionId: r.id,
				request: r.request_text!,
				functionName: r.function_name!,
				outcome: (r.outcome as SelectionOutcome | null) ?? null,
			}));
	}
	/** The toolchain the conversation chose for a run, if any. */
	function toolchainOfRunInTransaction(db: Database, runId: string) {
		const row = db
			.query(
				"SELECT toolchain_id FROM toolchain_selections WHERE run_id=? AND decision='toolchain'",
			)
			.get(runId) as { toolchain_id: string | null } | null;
		return row?.toolchain_id ?? undefined;
	}
	/** The request text the conversation handed to the toolchain of a run. */
	function requestOfRunInTransaction(db: Database, runId: string) {
		const row = db
			.query(
				"SELECT request_text FROM toolchain_selections WHERE run_id=? AND decision='toolchain'",
			)
			.get(runId) as { request_text: string | null } | null;
		return row?.request_text ?? undefined;
	}
	/** The query vector stored for a run, so procedures can be matched without a new embedding call. */
	function queryOfRunInTransaction(db: Database, runId: string) {
		const row = db
			.query(
				"SELECT query_space,query_vector FROM toolchain_selections WHERE run_id=?",
			)
			.get(runId) as Pick<SelectionRow, "query_space" | "query_vector"> | null;
		return row?.query_space && row.query_vector
			? { space: row.query_space, vector: unpackVector(row.query_vector) }
			: undefined;
	}
	// Management API (read-only views and explicit state changes).
	function listSelections(
		filter: {
			runId?: string;
			toolchainId?: string;
			since?: number;
			cursor?: number;
			limit?: number;
		} = {},
	) {
		const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
		return store.read((db) => {
			const rows = db
				.query(
					`SELECT * FROM toolchain_selections WHERE (?1 IS NULL OR run_id=?1) AND (?2 IS NULL OR toolchain_id=?2) AND (?3 IS NULL OR created_at>=?3) AND (?4 IS NULL OR created_at<?4) ORDER BY created_at DESC LIMIT ?5`,
				)
				.all(
					filter.runId ?? null,
					filter.toolchainId ?? null,
					filter.since ?? null,
					filter.cursor ?? null,
					limit + 1,
				) as SelectionRow[];
			return {
				items: rows.slice(0, limit).map(selection),
				nextCursor:
					rows.length > limit ? (rows[limit - 1]?.created_at ?? null) : null,
			};
		});
	}
	function getSelection(id: string) {
		return store.read((db) => {
			const row = db
				.query("SELECT * FROM toolchain_selections WHERE id=? OR run_id=?")
				.get(id, id) as SelectionRow | null;
			return row ? selection(row) : null;
		});
	}
	return {
		pruneInTransaction,
		recordSelectionInTransaction,
		linkTaskInTransaction,
		settleSelectionInTransaction,
		markRecipeInTransaction,
		toolchainOfRunInTransaction,
		requestOfRunInTransaction,
		queryOfRunInTransaction,
		similarSelectionsInTransaction,
		listSelections,
		getSelection,
	};
}
