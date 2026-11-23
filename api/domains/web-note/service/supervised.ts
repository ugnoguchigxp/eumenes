import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	isSupervisedExecutionSource,
	type SupervisedExecutionSource,
	type TaskLifecyclePort,
} from "../../tool-runtime";
import type { SourcePort } from "../contracts";
import { active, rowOf, stateOf } from "../repository";
import type { Context } from "./context";
import { end, viewInTransaction } from "./lifecycle";

type Start = Parameters<TaskLifecyclePort["startInTransaction"]>[1];

export function createSupervisedWebNotePort(
	ctx: Context,
	getSource: () => SourcePort | undefined,
	startInTransaction: (
		db: Database,
		input: Start,
		operationId: string,
	) => string,
) {
	function supervisedRow(
		db: Database,
		origin: SupervisedExecutionSource,
		id: string,
		action: "view" | "cancel",
		operationId?: string,
	) {
		const row = rowOf(db, id);
		if (!row?.data_json || !isSupervisedExecutionSource(origin)) return null;
		const state = stateOf(row);
		if (hash(origin) !== hash(state.source)) return null;
		return getSource()?.supervised?.authorizeInTransaction(db, {
			source: origin,
			workId: id,
			request: state.request,
			action,
			operationId,
			toolchainRevisionId: state.toolchainRevisionId,
			bindingRevisionId: state.bindingRevisionId,
		})
			? row
			: null;
	}

	return {
		startInTransaction(
			db: Database,
			input: Start & {
				source: SupervisedExecutionSource;
				operationId: string;
			},
		) {
			return viewInTransaction(
				db,
				startInTransaction(db, input, input.operationId),
			)!;
		},
		viewInTransaction(
			db: Database,
			origin: SupervisedExecutionSource,
			id: string,
		) {
			return supervisedRow(db, origin, id, "view")
				? viewInTransaction(db, id)
				: null;
		},
		cancelInTransaction(
			db: Database,
			origin: SupervisedExecutionSource,
			id: string,
			operationId: string,
		) {
			const row = supervisedRow(db, origin, id, "cancel", operationId);
			if (!row) throw new Error("web_note_source_invalid");
			if (active(row))
				end(ctx, db, row, "cancelled", "web_note_user_cancelled");
		},
	};
}
