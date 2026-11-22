import type { Database } from "bun:sqlite";
import { z } from "zod";
import type {
	SupervisedRow,
	SupervisionBoardControl,
} from "../../domains/development-supervision";
import type { DomainAdapter } from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";

export const supervisionOperation = "kanban.supervised.control";
export type BoardSupervision = {
	boardRowsInTransaction(
		db: Database,
		filter: { workspaceRef: string },
	): SupervisedRow[];
	boardRevisionInTransaction(db: Database): number;
	controlFromBoardInTransaction(
		db: Database,
		input: SupervisionBoardControl,
	): unknown;
};
export const supervisedControl = z.strictObject({
	parentId: z.uuid(),
	taskId: z.uuid(),
	expectedRevision: z.number().int().nonnegative(),
	action: z.enum(["amend", "cancel"]),
	request: z.string().trim().min(1).max(8000).optional(),
});
export function controlSupervisedRow(
	tx: Database,
	owner: BoardSupervision | undefined,
	request: Parameters<DomainAdapter["invokeInTransaction"]>[1],
) {
	if (
		request.origin.kind !== "ui" ||
		request.origin.actionRequestId !== request.requestId
	)
		throw new Error("supervision_board_authority_required");
	if (!owner) throw new Error("supervision_unavailable");
	const input = supervisedControl.parse(request.input);
	const row = owner
		.boardRowsInTransaction(tx, { workspaceRef: "eumenes" })
		.find(
			(entry) =>
				entry.parentId === input.parentId && entry.taskId === input.taskId,
		);
	if (!row) throw new Error("supervision_task_unavailable");
	owner.controlFromBoardInTransaction(tx, {
		...input,
		operationId: request.requestId,
		conversationId: row.conversationId,
	});
	const receipt = {
		parentId: row.parentId,
		taskId: row.taskId,
		action: input.action,
		operationId: request.requestId,
	};
	return {
		receipt,
		receiptRef: {
			owner: "development-supervision",
			operationId: request.requestId,
			digest: sha256Hex(JSON.stringify(receipt)),
		},
		resultRefs: [],
		replay: false,
	};
}
export function supervisedBoard<T extends { revision: number }>(
	tx: Database,
	owner: BoardSupervision | undefined,
	board: T,
) {
	const revision =
		board.revision + (owner?.boardRevisionInTransaction(tx) ?? 0);
	const rows =
		owner?.boardRowsInTransaction(tx, { workspaceRef: "eumenes" }) ?? [];
	const supervisedRows = rows.map((row) => ({
		parentId: row.parentId,
		taskId: row.taskId,
		parentRevision: row.parentRevision,
		revision: row.revision,
		title: row.title,
		column: row.column,
		state: row.state,
		reason: row.reason,
		blockerRef: row.blockerRef,
		evidenceRefs: row.evidenceRefs,
		designRevision: row.designRevision,
		result: row.result && {
			status: row.result.status,
			summary: row.result.summary,
			fulfilled: row.result.fulfilled,
			missing: row.result.missing,
		},
		...(row.state === "finished" ? { outcome: row.outcome } : {}),
	}));
	return { revision, data: { ...board, revision, supervisedRows } };
}
