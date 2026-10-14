import type {
	AdapterResult,
	DomainAdapter,
	FieldError,
	InputAdapter,
} from "../domains/tool-runtime";
import {
	kanbanAdd,
	kanbanCardRef,
	kanbanEdit,
	kanbanMove,
} from "../domains/capabilities/contracts";
import {
	kanbanReceiptSchema,
	type KanbanOutcome,
	type KanbanReceipt,
	type KanbanService,
} from "../domains/kanban";
import { sha256Hex } from "../infrastructure/digest";

export const KANBAN_ADAPTER_REF = "adapter:kanban@1";
const BOARD = "query:kanban.board@1";
const ADD = "input:kanban.add@1";
const EDIT = "input:kanban.edit@1";
const MOVE = "input:kanban.move@1";
const CARD = "input:kanban.card@1";

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
]);

/** What the kanban adapter offers, without a kanban service (bundle checks, evaluation). */
export const describeKanbanAdapter = () => ({
	owner: "kanban",
	operations: new Map([
		[
			"kanban.add",
			{ inputSchemaRef: "builtin:kanbanAdd", effect: "write" as const },
		],
		[
			"kanban.edit",
			{ inputSchemaRef: "builtin:kanbanEdit", effect: "write" as const },
		],
		[
			"kanban.move",
			{ inputSchemaRef: "builtin:kanbanMove", effect: "write" as const },
		],
		[
			"kanban.remove",
			{ inputSchemaRef: "builtin:kanbanCardRef", effect: "write" as const },
		],
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
			{
				owner: "kanban",
				kind: "card",
				id: receipt.cardId,
				schemaRef: "domain:kanban.receipt@1",
				revision: receipt.revision,
			},
		],
		replay,
		answerContext: {
			action: receipt.action,
			cardId: receipt.cardId,
			title: receipt.title,
			column: receipt.column,
		},
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
			let outcome: KanbanOutcome;
			switch (request.operationName) {
				case "kanban.add":
					outcome = kanban.addInTransaction(
						tx,
						kanbanAdd.parse(request.input),
						request.requestId,
					);
					break;
				case "kanban.edit":
					outcome = kanban.editInTransaction(
						tx,
						kanbanEdit.parse(request.input),
						request.requestId,
					);
					break;
				case "kanban.move":
					outcome = kanban.moveInTransaction(
						tx,
						kanbanMove.parse(request.input),
						request.requestId,
					);
					break;
				case "kanban.remove":
					outcome = kanban.removeInTransaction(
						tx,
						kanbanCardRef.parse(request.input),
						request.requestId,
					);
					break;
				default:
					throw new Error("capability_unavailable");
			}
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
			return { revision: board.revision, data: board };
		},
		targetInput: () => ({}),
	};
}
