import type { Database } from "bun:sqlite";
import type { ExecutionStatus } from "../../tool-runtime";
import {
	executionRow,
	executionView,
	type ExecutionRow,
} from "../repository/executions";
import type { ExecutionContext } from "./execution-context";
import { workQuery, type WorkQuery } from "../contracts/work-query";

/**
 * Completion reports held for the agency layer (spec agency-work-reports-design-2026-10-24): while the agency
 * watches a conversation, a finished execution's result notice is not sent at once; the agency picks the moment
 * and releases it (the conversation then answers it as before). `held` → `released`; a released row is archived.
 */
export type HeldReport = {
	eventId: string;
	executionId: string;
	conversationId: string;
	heldAt: number;
};

/** An execution as a work item of a conversation (open, or finished with its report held). */
export type ExecutionWorkItem = {
	id: string;
	conversationId: string;
	request: string;
	status: ExecutionStatus;
	pipeline: boolean;
	resultSummary: string | null;
	createdAt: number;
	updatedAt: number;
	/** Set while the result report is held for the agency. */
	heldEventId: string | null;
};

const OPEN = "('queued','deciding','waiting_child','waiting_user')";
const reportsTable = (db: Database) =>
	!!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_execution_reports'",
		)
		.get();

function item(
	row: ExecutionRow,
	heldEventId: string | null,
): ExecutionWorkItem {
	const view = executionView(row);
	return {
		id: row.id,
		conversationId: row.conversation_id,
		request: row.request,
		status: row.state,
		pipeline: view.pipeline === true,
		resultSummary: view.result?.summary ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		heldEventId,
	};
}

export function executionReports(
	ctx: ExecutionContext,
	table: (db: Database) => boolean,
) {
	const ready = (db: Database) => table(db) && reportsTable(db);
	/** Held reports, oldest first; of one conversation when given. */
	function held(db: Database, conversationId?: string): HeldReport[] {
		if (!ready(db)) return [];
		const rows = (
			conversationId === undefined
				? db
						.query(
							"SELECT event_id,execution_id,conversation_id,held_at FROM agent_execution_reports WHERE state='held' ORDER BY held_at,event_id",
						)
						.all()
				: db
						.query(
							"SELECT event_id,execution_id,conversation_id,held_at FROM agent_execution_reports WHERE state='held' AND conversation_id=? ORDER BY held_at,event_id",
						)
						.all(conversationId)
		) as Array<{
			event_id: string;
			execution_id: string;
			conversation_id: string;
			held_at: number;
		}>;
		return rows.map((r) => ({
			eventId: r.event_id,
			executionId: r.execution_id,
			conversationId: r.conversation_id,
			heldAt: r.held_at,
		}));
	}
	const api = {
		/** Holds a result notice instead of sending it; idempotent per event. */
		holdReportInTransaction(
			db: Database,
			input: { eventId: string; executionId: string; conversationId: string },
		) {
			if (!ready(db)) return false;
			db.query(
				"INSERT OR IGNORE INTO agent_execution_reports(event_id,execution_id,conversation_id,state,held_at) VALUES(?,?,?,'held',?)",
			).run(input.eventId, input.executionId, input.conversationId, ctx.now());
			return true;
		},
		heldReportsInTransaction: held,
		/** Marks a held report released (archived); false when it was not held. */
		releaseReportInTransaction(db: Database, eventId: string): boolean {
			if (!ready(db)) return false;
			return (
				db
					.query(
						"UPDATE agent_execution_reports SET state='released',released_at=? WHERE event_id=? AND state='held'",
					)
					.run(ctx.now(), eventId).changes === 1
			);
		},
		/**
		 * A released report whose notice cannot be sent (its conversation source is gone): the event is settled as
		 * delivered so the delivery loop stops polling it.
		 */
		settleEventInTransaction(db: Database, eventId: string) {
			db.query(
				"UPDATE agent_execution_events SET state='delivered' WHERE id=? AND state IN ('pending','accepted')",
			).run(eventId);
		},
		/** Open executions and finished ones whose report is held, of one conversation (newest first, bounded). */
		workItemsInTransaction(
			db: Database,
			conversationId: string,
		): ExecutionWorkItem[] {
			if (!ready(db)) return [];
			const open = (
				db
					.query(
						`SELECT * FROM agent_executions WHERE conversation_id=? AND state IN ${OPEN} ORDER BY created_at DESC LIMIT 8`,
					)
					.all(conversationId) as ExecutionRow[]
			).map((row) => item(row, null));
			// One item per execution even if two of its events were held (e.g. a result and a stop notice).
			const seen = new Set<string>();
			const waiting = held(db, conversationId).flatMap((r) => {
				if (seen.has(r.executionId)) return [];
				seen.add(r.executionId);
				const row = executionRow(db, r.executionId);
				return row ? [item(row, r.eventId)] : [];
			});
			return [...waiting, ...open];
		},
		/** The TODO view of one conversation (read-only display): open and held items, then archived ones. */
		agencyWork(conversationId: string) {
			return ctx.store.read((db) => ({
				items: api.workItemsInTransaction(db, conversationId),
				archived: api.archivedItemsInTransaction(db, conversationId),
			}));
		},
		/** Full read-only list, paged in SQL. Reporting decisions still use workItemsInTransaction. */
		agencyWorkPageInTransaction(
			db: Database,
			conversationId: string,
			input: WorkQuery,
		) {
			const query = workQuery.parse(input);
			const counts = { todo: 0, done: 0, archived: 0 };
			if (!ready(db))
				return { rows: [], counts, total: 0, ...query, pageIndex: 0 };
			// Group reports before joining: several events of one execution remain one work item.
			const work = `WITH work AS (
					SELECT e.*, r.held_event_id, r.released_at
					FROM agent_executions e LEFT JOIN (
						SELECT execution_id,
							MIN(CASE WHEN state='held' THEN event_id END) held_event_id,
							MAX(CASE WHEN state='released' THEN released_at END) released_at
						FROM agent_execution_reports WHERE conversation_id=? GROUP BY execution_id
					) r ON r.execution_id=e.id WHERE e.conversation_id=?
				)`;
			const totals = db
				.query(`${work} SELECT
					COUNT(CASE WHEN state IN ${OPEN} THEN 1 END) todo,
					COUNT(held_event_id) done, COUNT(released_at) archived,
					COUNT(CASE WHEN state IN ${OPEN} OR held_event_id IS NOT NULL THEN 1 END) active FROM work`)
				.get(conversationId, conversationId) as typeof counts & {
				active: number;
			};
			const total = totals[query.state];
			const pageIndex = Math.min(
				query.pageIndex,
				Math.max(0, Math.ceil(total / query.pageSize) - 1),
			);
			const conditions = {
				active: `state IN ${OPEN} OR held_event_id IS NOT NULL`,
				todo: `state IN ${OPEN}`,
				done: "held_event_id IS NOT NULL",
				archived: "released_at IS NOT NULL",
			};
			const order = {
				active: "created_at",
				todo: "created_at",
				done: "updated_at",
				archived: "released_at",
			};
			const rows = db
				.query(`${work} SELECT * FROM work WHERE ${conditions[query.state]}
					ORDER BY ${order[query.state]} DESC,id DESC LIMIT ? OFFSET ?`)
				.all(
					conversationId,
					conversationId,
					query.pageSize,
					pageIndex * query.pageSize,
				) as Array<
				ExecutionRow & {
					held_event_id: string | null;
					released_at: number | null;
				}
			>;
			return {
				...query,
				pageIndex,
				total,
				counts: {
					todo: totals.todo,
					done: totals.done,
					archived: totals.archived,
				},
				rows: rows.map((row) => ({
					...item(row, row.held_event_id),
					state:
						query.state === "archived"
							? ("archived" as const)
							: row.held_event_id !== null
								? ("done" as const)
								: ("todo" as const),
					releasedAt: row.released_at,
				})),
			};
		},
		agencyWorkPage(conversationId: string, input: WorkQuery) {
			return ctx.store.read((db) =>
				api.agencyWorkPageInTransaction(db, conversationId, input),
			);
		},
		/** Released (archived) reports of one conversation, newest first (for display). */
		archivedItemsInTransaction(
			db: Database,
			conversationId: string,
			limit = 20,
		): Array<ExecutionWorkItem & { releasedAt: number }> {
			if (!ready(db)) return [];
			const rows = db
				.query(
					"SELECT execution_id,released_at FROM agent_execution_reports WHERE conversation_id=? AND state='released' ORDER BY released_at DESC LIMIT ?",
				)
				.all(conversationId, limit) as Array<{
				execution_id: string;
				released_at: number;
			}>;
			return rows.flatMap((r) => {
				const row = executionRow(db, r.execution_id);
				return row ? [{ ...item(row, null), releasedAt: r.released_at }] : [];
			});
		},
	};
	return api;
}
