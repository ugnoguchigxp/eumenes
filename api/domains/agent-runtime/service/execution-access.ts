import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	executionReference,
	type ExecutionReference,
} from "../../tool-runtime";
import {
	eraseExecutionBodies,
	executionRow,
	executionSource,
	executionState,
	executionView,
	isExecutionActive,
	saveExecution,
	type ExecutionRow,
} from "../repository/executions";
import type { ExecutionContext } from "./execution-context";

import type { ExecutionOps } from "./execution-store";
export function executionAccess(
	ctx: ExecutionContext,
	ops: ExecutionOps,
	table: (db: Database) => boolean,
	configured: () => boolean,
) {
	const { store, now } = ctx;
	function purge(db: Database, row: ExecutionRow) {
		const children = (
			db
				.query(
					"SELECT input_json FROM agent_execution_steps WHERE execution_id=? AND input_json IS NOT NULL",
				)
				.all(row.id) as { input_json: string }[]
		).map(
			(r) =>
				JSON.parse(r.input_json) as import("../../tool-runtime").ChildExecution,
		);
		for (const event of db
			.query(
				"SELECT id FROM agent_execution_events WHERE execution_id=? AND state IN ('pending','accepted')",
			)
			.all(row.id) as { id: string }[])
			ctx.port().revokeDeliveryInTransaction?.(db, event.id);
		ctx.port().purgeSourcesInTransaction?.(db, executionSource(row), children);
		eraseExecutionBodies(db, row, now());
	}
	return {
		stopRequestedInTransaction(
			db: Database,
			child: Pick<
				import("../../tool-runtime").ChildExecution,
				"executionId" | "id"
			>,
		) {
			const row = executionRow(db, child.executionId);
			return (
				!!row &&
				(!isExecutionActive(row) || executionState(row).amending === true) &&
				db
					.query(
						"SELECT 1 FROM agent_execution_steps WHERE id=? AND execution_id=?",
					)
					.get(child.id, row.id) !== null
			);
		},
		stopUnconfirmedInTransaction(
			db: Database,
			child: Pick<
				import("../../tool-runtime").ChildExecution,
				"executionId" | "id"
			>,
		) {
			const row = executionRow(db, child.executionId);
			if (!row) return;
			const state = executionState(row);
			if (!isExecutionActive(row)) {
				if (!row.source_json || !row.result_json) return;
				const result = JSON.parse(row.result_json);
				result.code = "operation_stop_unconfirmed";
				result.missing = [
					...new Set([...result.missing, "operation_stop_unconfirmed"]),
				];
				row.result_json = JSON.stringify(result);
				saveExecution(db, row, state, now());
				db.query(
					"INSERT OR IGNORE INTO agent_execution_events(id,execution_id,kind) VALUES(?,?,?)",
				).run(
					`execution:${row.id}:stop-unconfirmed`,
					row.id,
					"stop-unconfirmed",
				);
				return;
			}
			if (state.pending?.child.id === child.id)
				ops.fail(db, row, state, "operation_stop_unconfirmed");
		},
		purgeSourcesInTransaction(
			db: Database,
			input: { messageIds: readonly string[]; itemIds: readonly string[] },
		) {
			if (!configured() || !table(db)) return;
			const erased = new Set<string>();
			for (const row of db
				.query(
					"SELECT * FROM agent_executions WHERE source_json IS NOT NULL ORDER BY created_at,id",
				)
				.all() as ExecutionRow[]) {
				const source = executionSource(row),
					state = executionState(row);
				const dependent =
					[
						source.messageId,
						...(source.amendments ?? []).map((update) => update.messageId),
						...(source.responses ?? []).map((update) => update.messageId),
					].some((id) => input.messageIds.includes(id)) ||
					state.refs.some(
						(ref) =>
							(ref.kind === "memory" && input.itemIds.includes(ref.id)) ||
							(ref.kind === "message" && input.messageIds.includes(ref.id)) ||
							(ref.owner === "agent-runtime" &&
								erased.has(
									(
										db
											.query(
												"SELECT execution_id FROM agent_execution_steps WHERE id=?",
											)
											.get(ref.id) as { execution_id: string } | null
									)?.execution_id ?? "",
								)),
					);
				if (!dependent) continue;
				if (isExecutionActive(row))
					ops.fail(db, row, state, "execution_source_forgotten", "cancelled");
				purge(db, executionRow(db, row.id)!);
				erased.add(row.id);
			}
		},
		sourceRunInTransaction(db: Database, id: string) {
			const row = executionRow(db, id);
			return row?.source_json ? executionSource(row).runId : null;
		},
		authorizeChildInTransaction(
			db: Database,
			child: import("../../tool-runtime").ChildExecution,
		) {
			const row = executionRow(db, child.executionId);
			return (
				!!row &&
				isExecutionActive(row) &&
				row.request_revision === child.revision &&
				row.deadline > now() &&
				ctx.port().controlInTransaction(db)?.revisionId ===
					executionState(row).bindingRevisionId &&
				executionState(row).pending?.child.id === child.id &&
				executionState(row).pending?.child.dispatchId === child.dispatchId &&
				!!ctx.port().validSourceInTransaction(db, child.source) &&
				child.refs.every((ref) =>
					ctx.port().validReferenceInTransaction(db, child.source, ref),
				)
			);
		},
		contextReferencesInTransaction(
			db: Database,
			conversationId: string,
		): ExecutionReference[] {
			if (!table(db)) return [];
			return (
				db
					.query(
						"SELECT r.reference_json FROM agent_execution_refs r JOIN agent_executions e ON e.id=r.execution_id WHERE e.conversation_id=? AND json_extract(r.reference_json,'$.owner')='agent-runtime' ORDER BY e.updated_at DESC LIMIT 8",
					)
					.all(conversationId) as { reference_json: string }[]
			).map((r) => executionReference.parse(JSON.parse(r.reference_json)));
		},
		resultReferenceInTransaction(
			db: Database,
			conversationId: string,
			ref: ExecutionReference,
		) {
			const step = db
				.query(
					"SELECT s.input_json,s.result_json,e.conversation_id FROM agent_execution_steps s JOIN agent_executions e ON e.id=s.execution_id WHERE s.id=?",
				)
				.get(ref.id) as {
				input_json: string | null;
				result_json: string | null;
				conversation_id: string;
			} | null;
			if (
				!step?.result_json ||
				!step.input_json ||
				step.conversation_id !== conversationId ||
				hash(JSON.parse(step.result_json)) !== ref.digest
			)
				return null;
			return {
				child: JSON.parse(
					step.input_json,
				) as import("../../tool-runtime").ChildExecution,
				result: JSON.parse(
					step.result_json,
				) as import("../../tool-runtime").ChildResult,
			};
		},
		viewInTransaction: (db: Database, id: string) => {
			const row = table(db) ? executionRow(db, id) : null;
			return row ? executionView(row) : null;
		},
		listInTransaction: (db: Database, conversationId: string) =>
			table(db)
				? (
						db
							.query(
								"SELECT * FROM agent_executions WHERE conversation_id=? ORDER BY updated_at DESC LIMIT 8",
							)
							.all(conversationId) as ExecutionRow[]
					).map(executionView)
				: [],
		get: (id: string) =>
			store.read((db) => {
				const row = table(db) ? executionRow(db, id) : null;
				return row ? executionView(row) : null;
			}),
		list: (conversationId: string) =>
			store.read((db) =>
				table(db)
					? (
							db
								.query(
									"SELECT * FROM agent_executions WHERE conversation_id=? AND source_json IS NOT NULL ORDER BY updated_at DESC LIMIT 8",
								)
								.all(conversationId) as ExecutionRow[]
						).map(executionView)
					: [],
			),
		async maintenance() {
			if (!configured() || !store.read(table)) return;
			await store.write((db) => {
				for (const row of db
					.query("SELECT * FROM agent_executions WHERE source_json IS NOT NULL")
					.all() as ExecutionRow[]) {
					if (isExecutionActive(row)) continue;
					if (
						row.created_at + 14 * 86_400_000 > now() &&
						ctx.port().validSourceInTransaction(db, executionSource(row))
					)
						continue;
					purge(db, row);
				}
				for (const row of db
					.query(
						"SELECT id FROM agent_executions WHERE created_at<? AND source_json IS NULL",
					)
					.all(now() - 30 * 86_400_000) as { id: string }[]) {
					for (const table of [
						"agent_execution_steps",
						"agent_execution_refs",
						"agent_execution_questions",
						"agent_execution_events",
					])
						db.query(`DELETE FROM ${table} WHERE execution_id=?`).run(row.id);
					db.query("DELETE FROM agent_executions WHERE id=?").run(row.id);
				}
			});
		},
	};
}
