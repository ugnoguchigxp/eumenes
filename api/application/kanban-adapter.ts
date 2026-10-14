import type {
	AdapterResult,
	DomainAdapter,
	FieldError,
	InputAdapter,
} from "../domains/tool-runtime";
import type { Database } from "bun:sqlite";
import {
	kanbanAdd,
	kanbanCardRef,
	kanbanEdit,
	kanbanFollowup,
	kanbanList,
	kanbanMove,
} from "../domains/capabilities/contracts";
import {
	kanbanReceiptSchema,
	type KanbanOperationContext,
	type KanbanOutcome,
	type KanbanReceipt,
	type KanbanService,
} from "../domains/kanban";
import { sha256Hex } from "../infrastructure/digest";
import { composeBoard, connectionOf, enqueueDispatch } from "./kanban-runs";

export const KANBAN_ADAPTER_REF = "adapter:kanban@1";
const BOARD = "query:kanban.board@1";
const ADD = "input:kanban.add@1";
const EDIT = "input:kanban.edit@1";
const MOVE = "input:kanban.move@1";
const CARD = "input:kanban.card@1";
const FOLLOWUP = "input:kanban.followup@1";

/** Domain result schemas this adapter registers for `domain:` refs. */
export const kanbanDomainSchemas = {
	"domain:kanban.receipt@1": kanbanReceiptSchema,
} as const;

type Fields = Record<string, unknown>;
type Converted =
	| { ok: true; value: Fields }
	| { ok: false; errors: FieldError[] };

/**
 * The string values of the board events (spec §2.2) to typed fields. Each reader records a
 * field error instead of throwing, so one rejected input reports every problem at once.
 */
function reader(raw: Record<string, unknown>) {
	const errors: FieldError[] = [];
	const value: Fields = {};
	return {
		errors,
		value,
		text(field: string, optional = false) {
			const input = raw[field];
			if (input === undefined && optional) return;
			if (typeof input !== "string" || !input.trim())
				errors.push({ field, message: "入力してください" });
			else value[field] = input;
		},
		id(field: string) {
			const input = raw[field];
			if (typeof input !== "string" || !input)
				errors.push({ field, message: "カードを指定してください" });
			else value[field] = input;
		},
		revision() {
			const input = raw.expectedRevision;
			if (typeof input !== "string" || !/^[1-9]\d{0,9}$/.test(input))
				errors.push({
					field: "expectedRevision",
					message: "revision を確認してください",
				});
			else value.expectedRevision = Number(input);
		},
		column() {
			const input = raw.column;
			if (input !== "todo" && input !== "finished")
				errors.push({ field: "column", message: "移動先を確認してください" });
			else value.column = input;
		},
		/** An empty string is the end of the column. */
		before() {
			const input = raw.beforeCardId;
			if (typeof input !== "string")
				errors.push({
					field: "beforeCardId",
					message: "位置を確認してください",
				});
			else value.beforeCardId = input === "" ? null : input;
		},
		done(): Converted {
			return errors.length ? { ok: false, errors } : { ok: true, value };
		},
	};
}

const convert =
	(read: (r: ReturnType<typeof reader>) => void): InputAdapter =>
	(raw) => {
		const r = reader(raw);
		read(r);
		return r.done();
	};

const kanbanInputAdapters = new Map<string, InputAdapter>([
	[
		ADD,
		convert((r) => {
			r.text("title");
			r.text("prompt");
		}),
	],
	[
		EDIT,
		convert((r) => {
			r.id("cardId");
			r.revision();
			r.text("title", true);
			r.text("prompt", true);
		}),
	],
	[
		MOVE,
		convert((r) => {
			r.id("cardId");
			r.revision();
			r.column();
			r.before();
		}),
	],
	[
		CARD,
		convert((r) => {
			r.id("cardId");
			r.revision();
		}),
	],
	[
		FOLLOWUP,
		convert((r) => {
			r.id("cardId");
			r.revision();
			r.text("note");
		}),
	],
]);

const write = (inputSchemaRef: string) => ({
	inputSchemaRef,
	effect: "write" as const,
});

/** What the kanban adapter offers, without a kanban service (bundle checks, evaluation). */
export const describeKanbanAdapter = () => ({
	owner: "kanban",
	operations: new Map([
		["kanban.add", write("builtin:kanbanAdd")],
		["kanban.edit", write("builtin:kanbanEdit")],
		["kanban.move", write("builtin:kanbanMove")],
		["kanban.remove", write("builtin:kanbanCardRef")],
		["kanban.run", write("builtin:kanbanCardRef")],
		["kanban.followup", write("builtin:kanbanFollowup")],
		["kanban.commit-push", write("builtin:kanbanCardRef")],
		["kanban.review", write("builtin:kanbanCardRef")],
		["kanban.cancel", write("builtin:kanbanCardRef")],
		["kanban.stop", write("builtin:kanbanCardRef")],
		["kanban.reset", write("builtin:kanbanCardRef")],
		["kanban.resume-queue", write("builtin:kanbanList")],
	]),
	queries: new Set([BOARD]),
	inputAdapters: kanbanInputAdapters,
	projections: new Set(["projection:kanban.result@1"]),
	availability: "availability:kanban@1",
});

function result(receipt: KanbanReceipt, requestId: string, replay: boolean) {
	return {
		receipt,
		receiptRef: {
			owner: "kanban",
			operationId: requestId,
			digest: sha256Hex(JSON.stringify(receipt)),
		},
		resultRefs: [
			"cardId" in receipt
				? {
						owner: "kanban",
						kind: "card",
						id: receipt.cardId,
						schemaRef: "domain:kanban.receipt@1",
						revision: receipt.revision,
					}
				: {
						owner: "kanban",
						kind: "queue",
						id: "queue",
						schemaRef: "domain:kanban.receipt@1",
					},
		],
		replay,
		answerContext:
			"cardId" in receipt
				? {
						action: receipt.action,
						cardId: receipt.cardId,
						title: receipt.title,
						column: receipt.column,
						// Saving a run is not finishing it: the person is told in the notification center.
						...(receipt.runId && ["run", "followup"].includes(receipt.action)
							? { queued: true, reportedWhen: "通知センターでお知らせします" }
							: {}),
					}
				: { action: receipt.action, queue: receipt.queue },
	} satisfies AdapterResult;
}

/**
 * The typed kanban adapter: every card operation goes through the kanban domain's public
 * transaction operations, so its revision, order and receipts stay the only source of truth.
 * `runnable` is the host's answer to "can runs be tracked here" (terminals hooks available).
 */
export function createKanbanAdapter(
	kanban: KanbanService,
	options: { runnable: () => boolean },
): DomainAdapter {
	/** Runs are handed over through the host's connection (`connectKanbanRuns`). */
	const connection = () => {
		const connected = connectionOf(kanban);
		if (!connected) throw new Error("kanban_not_connected");
		return connected;
	};
	type Handler = (
		tx: Database,
		input: unknown,
		requestId: string,
		context: KanbanOperationContext,
	) => KanbanOutcome<KanbanReceipt>;
	const cancelUnsent = (tx: Database) => (runId: string) =>
		connection().terminals.cancelQueuedInTransaction(tx, runId);
	const handlers: Record<string, Handler> = {
		"kanban.add": (tx, input, id) =>
			kanban.addInTransaction(tx, kanbanAdd.parse(input), id),
		"kanban.edit": (tx, input, id) =>
			kanban.editInTransaction(tx, kanbanEdit.parse(input), id),
		"kanban.move": (tx, input, id) =>
			kanban.moveInTransaction(tx, kanbanMove.parse(input), id),
		"kanban.remove": (tx, input, id) =>
			kanban.removeInTransaction(tx, kanbanCardRef.parse(input), id),
		"kanban.run": (tx, input, id, context) =>
			kanban.runInTransaction(tx, kanbanCardRef.parse(input), id, context),
		"kanban.followup": (tx, input, id, context) =>
			kanban.followupInTransaction(
				tx,
				kanbanFollowup.parse(input),
				id,
				context,
			),
		"kanban.commit-push": (tx, input, id, context) =>
			kanban.commitPushInTransaction(
				tx,
				kanbanCardRef.parse(input),
				id,
				context,
			),
		"kanban.review": (tx, input, id) =>
			kanban.reviewInTransaction(tx, kanbanCardRef.parse(input), id),
		"kanban.cancel": (tx, input, id) =>
			kanban.cancelInTransaction(
				tx,
				kanbanCardRef.parse(input),
				id,
				cancelUnsent(tx),
			),
		"kanban.stop": (tx, input, id) =>
			kanban.stopInTransaction(
				tx,
				kanbanCardRef.parse(input),
				id,
				cancelUnsent(tx),
			),
		"kanban.reset": (tx, input, id) =>
			kanban.resetInTransaction(tx, kanbanCardRef.parse(input), id),
		"kanban.resume-queue": (tx, input, id) => {
			kanbanList.parse(input);
			return kanban.resumeQueueInTransaction(tx, id);
		},
	};
	return {
		ref: KANBAN_ADAPTER_REF,
		describe: describeKanbanAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (tx) => ({
			cards: kanban
				.boardInTransaction(tx, { runnable: options.runnable() })
				.cards.map(({ id, revision, title, column, label }) => ({
					id,
					revision,
					title,
					column,
					...(label ? { label } : {}),
				})),
		}),
		invokeInTransaction(tx, request) {
			const handler = handlers[request.operationName];
			if (!handler) throw new Error("capability_unavailable");
			const outcome = handler(tx, request.input, request.requestId, {
				origin:
					request.origin.kind === "conversation" ? "conversation" : "board",
				...(request.origin.kind === "conversation"
					? { conversationId: request.origin.conversationId }
					: {}),
				runnable: options.runnable(),
			});
			// A run that became ready is handed over in this transaction; it is sent after commit.
			if (outcome.dispatch)
				enqueueDispatch(connection().terminals, tx, outcome.dispatch);
			return result(outcome.receipt, request.requestId, outcome.replay);
		},
		readInTransaction(tx, operationId) {
			const saved = kanban.receiptInTransaction(tx, operationId);
			return saved ? result(saved, operationId, true) : null;
		},
		sourceInTransaction(tx, query, targetRef) {
			if (query !== BOARD || targetRef !== undefined) return null;
			const board = kanban.boardInTransaction(tx, {
				runnable: options.runnable(),
			});
			const connected = connectionOf(kanban);
			const shown = connected
				? composeBoard(board, tx, connected.terminals)
				: board;
			return { revision: shown.revision, data: shown };
		},
		targetInput: () => ({}),
		/** Stops the person asked for run once their transaction committed. */
		afterCommit: () => connectionOf(kanban)?.stopper.flush(),
	};
}
