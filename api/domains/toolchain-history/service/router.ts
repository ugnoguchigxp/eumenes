import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../../capabilities";
import {
	ROUTER_TRACE_RETENTION_MS,
	type NearFeedback,
	type RouterFeedback,
	type RouterFeedbackSource,
	type RouterFeedbackState,
	type RouterQuery,
	type RouterTrace,
	type RouterTraceRecord,
} from "../contracts";
import type { RouterFeedbackRow, RouterTraceRow } from "../repository";

const log = getLogger("toolchain-history");
const NEAR_SCAN = 500;
const NEAR_LIMIT = 5;
const LIST_LIMIT = 200;
const LIST_DEFAULT = 50;
const TEXT_MAX = 2000;

const cap = (text: string) => text.slice(0, TEXT_MAX);

function query(row: {
	query_vector: Uint8Array | null;
	query_space_json: string | null;
}): RouterQuery | null {
	return row.query_vector && row.query_space_json
		? {
				space: JSON.parse(row.query_space_json),
				vector: Array.from(unpackVector(row.query_vector)),
			}
		: null;
}
/** The messages a record's text was made from: the primary one first, each once. */
function messageIdsJson(primary: string, more: readonly string[] = []) {
	return JSON.stringify([...new Set([primary, ...more])]);
}
function traceRecord(row: RouterTraceRow): RouterTraceRecord {
	const trace = JSON.parse(row.trace_json) as Pick<RouterTrace, "row" | "mode">;
	return {
		runId: row.run_id,
		conversationId: row.conversation_id,
		messageId: row.message_id,
		messageIds: JSON.parse(row.message_ids_json),
		text: row.query_text,
		query: query(row),
		decided: row.decided_id,
		workId: row.work_id,
		set: JSON.parse(row.set_json),
		row: trace.row,
		mode: trace.mode,
		createdAt: row.created_at,
	};
}
function feedback(row: RouterFeedbackRow): RouterFeedback {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		messageId: row.message_id,
		runId: row.run_id,
		source: row.source,
		text: row.query_text,
		wrongId: row.wrong_id,
		rightId: row.right_id,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * The router's per-turn traces and the user's corrections (spec toolchain-router-redesign §5.3). Both hold the
 * utterance the user said, so a forget of its message removes them; no operation here logs the text.
 */
export function createRouter(store: SqliteStore, now: () => number) {
	function pruneTracesInTransaction(db: Database) {
		db.query(
			"DELETE FROM router_traces WHERE run_id IN (SELECT run_id FROM router_traces WHERE expires_at<=? LIMIT 200)",
		).run(now());
	}
	/** One row per run; a later write of the same run replaces the trace and keeps the work it started. */
	function recordRouterTraceInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			messageId: string;
			messageIds?: readonly string[];
			text: string;
			query: { space: RouterQuery["space"]; vector: number[] } | null;
			trace: RouterTrace;
		},
	) {
		pruneTracesInTransaction(db);
		const at = now();
		db.query(
			`INSERT INTO router_traces(run_id,conversation_id,message_id,message_ids_json,query_text,query_space,query_space_json,query_vector,decided_id,set_json,trace_json,created_at,expires_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(run_id) DO UPDATE SET conversation_id=excluded.conversation_id,message_id=excluded.message_id,message_ids_json=excluded.message_ids_json,query_text=excluded.query_text,query_space=excluded.query_space,query_space_json=excluded.query_space_json,query_vector=excluded.query_vector,decided_id=excluded.decided_id,set_json=excluded.set_json,trace_json=excluded.trace_json`,
		).run(
			input.runId,
			input.conversationId,
			input.messageId,
			messageIdsJson(input.messageId, input.messageIds),
			cap(input.text),
			input.query ? vectorSpaceKey(input.query.space) : null,
			input.query ? JSON.stringify(input.query.space) : null,
			input.query ? packVector(input.query.vector) : null,
			input.trace.decided,
			JSON.stringify(input.trace.set),
			JSON.stringify(input.trace),
			at,
			at + ROUTER_TRACE_RETENTION_MS,
		);
		log.info("toolchain.router_trace_recorded", {
			runId: input.runId,
			candidateCount: input.trace.candidates.length,
		});
	}
	function linkRouterWorkInTransaction(
		db: Database,
		runId: string,
		workId: string,
	) {
		db.query("UPDATE router_traces SET work_id=? WHERE run_id=?").run(
			workId,
			runId,
		);
	}
	/** The conversation's newest trace made at `since` or later, whatever it decided. */
	function latestRouterTraceInTransaction(
		db: Database,
		input: { conversationId: string; since: number },
	): RouterTraceRecord | null {
		const row = db
			.query(
				"SELECT * FROM router_traces WHERE conversation_id=? AND created_at>=? AND expires_at>? ORDER BY created_at DESC LIMIT 1",
			)
			.get(input.conversationId, input.since, now()) as RouterTraceRow | null;
		return row ? traceRecord(row) : null;
	}
	function recordRouterFeedbackInTransaction(
		db: Database,
		input: {
			conversationId: string;
			messageId: string;
			messageIds?: readonly string[];
			runId: string;
			source: RouterFeedbackSource;
			text: string;
			query: RouterQuery;
			wrongId: string | null;
			rightId: string;
		},
	) {
		const id = crypto.randomUUID();
		const at = now();
		db.query(
			`INSERT INTO router_feedback(id,conversation_id,message_id,message_ids_json,run_id,source,query_text,query_space,query_vector,wrong_id,right_id,state,created_at,updated_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
		).run(
			id,
			input.conversationId,
			input.messageId,
			messageIdsJson(input.messageId, input.messageIds),
			input.runId,
			input.source,
			cap(input.text),
			vectorSpaceKey(input.query.space),
			packVector(input.query.vector),
			input.wrongId,
			input.rightId,
			at,
			at,
		);
		log.info("toolchain.router_feedback_recorded", {
			subjectId: id,
			runId: input.runId,
			source: input.source,
		});
		return id;
	}
	/** Active corrections of the vector's space at least `threshold` similar, nearest first (the newest 500 are scanned). */
	function nearRouterFeedbackInTransaction(
		db: Database,
		input: RouterQuery & { threshold: number; limit?: number },
	): NearFeedback[] {
		const rows = db
			.query(
				"SELECT id,wrong_id,right_id,query_vector FROM router_feedback WHERE query_space=? AND state='active' ORDER BY created_at DESC,rowid DESC LIMIT ?",
			)
			.all(vectorSpaceKey(input.space), NEAR_SCAN) as Array<
			Pick<RouterFeedbackRow, "id" | "wrong_id" | "right_id" | "query_vector">
		>;
		return rows
			.map((r) => {
				const v = unpackVector(r.query_vector);
				return {
					id: r.id,
					wrongId: r.wrong_id,
					rightId: r.right_id,
					similarity:
						v.length === input.vector.length
							? dot(v, input.vector)
							: Number.NEGATIVE_INFINITY,
				};
			})
			.filter((f) => f.similarity >= input.threshold)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, input.limit ?? NEAR_LIMIT);
	}
	function setRouterFeedbackStateInTransaction(
		db: Database,
		id: string,
		state: RouterFeedbackState,
	) {
		const changed = db
			.query("UPDATE router_feedback SET state=?,updated_at=? WHERE id=?")
			.run(state, now(), id).changes;
		if (changed)
			log.info("toolchain.router_feedback_state", {
				subjectId: id,
				phase: state,
			});
		return changed > 0;
	}
	function listRouterFeedbackInTransaction(
		db: Database,
		filter: { state?: RouterFeedbackState; limit?: number } = {},
	): RouterFeedback[] {
		const limit = Math.min(
			LIST_LIMIT,
			Math.max(1, filter.limit ?? LIST_DEFAULT),
		);
		return (
			db
				.query(
					"SELECT * FROM router_feedback WHERE (?1 IS NULL OR state=?1) ORDER BY created_at DESC,rowid DESC LIMIT ?2",
				)
				.all(filter.state ?? null, limit) as RouterFeedbackRow[]
		).map(feedback);
	}
	/** Removes the traces and corrections made from the given messages (the memory forget purge). */
	function forgetRouterInTransaction(
		db: Database,
		messageIds: readonly string[],
	) {
		if (!messageIds.length) return 0;
		let removed = 0;
		for (const table of ["router_traces", "router_feedback"]) {
			// SQLite's bound-variable limit is respected by deleting in chunks.
			for (let i = 0; i < messageIds.length; i += 250) {
				const chunk = messageIds.slice(i, i + 250);
				const marks = chunk.map(() => "?").join(",");
				removed += db
					.query(
						`DELETE FROM ${table} WHERE message_id IN (${marks}) OR EXISTS (SELECT 1 FROM json_each(${table}.message_ids_json) m WHERE m.value IN (${marks}))`,
					)
					.run(...chunk, ...chunk).changes;
			}
		}
		if (removed) log.info("toolchain.router_forgotten", { count: removed });
		return removed;
	}
	return {
		recordRouterTraceInTransaction,
		linkRouterWorkInTransaction,
		latestRouterTraceInTransaction,
		recordRouterFeedbackInTransaction,
		nearRouterFeedbackInTransaction,
		setRouterFeedbackStateInTransaction,
		listRouterFeedbackInTransaction,
		forgetRouterInTransaction,
		listRouterFeedback: (filter?: {
			state?: RouterFeedbackState;
			limit?: number;
		}) => store.read((db) => listRouterFeedbackInTransaction(db, filter)),
		setRouterFeedbackState: (id: string, state: RouterFeedbackState) =>
			store.write((db) => setRouterFeedbackStateInTransaction(db, id, state)),
	};
}
