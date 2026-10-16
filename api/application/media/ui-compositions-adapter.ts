import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";
import type { DomainAdapter, AdapterResult } from "../../domains/tool-runtime";
import {
	uiComposeRequest,
	uiCancelRequest,
	uiResponseFields,
	uiSubmitRequest,
} from "../../domains/capabilities/contracts";
import type { UiCompositionsService } from "../../domains/ui-compositions";

export const UI_COMPOSITIONS_ADAPTER_REF = "adapter:ui-compositions@1";
const LIST = "query:ui-compositions.list@1";
const FORM = "query:ui-compositions.form@1";
const INPUT = "input:ui-compositions.response@1";
const uiCompositionsReceipt = z.strictObject({
	projectId: z.string(),
	state: z.string(),
	responseId: z.string().optional(),
});
export const uiCompositionsDomainSchemas = {
	"domain:ui-compositions.receipt@1": uiCompositionsReceipt,
};
export const describeUiCompositionsAdapter = () => ({
	owner: "ui-compositions",
	operations: new Map([
		[
			"ui-compositions.compose",
			{ inputSchemaRef: "builtin:uiComposeRequest", effect: "write" as const },
		],
		[
			"ui-compositions.submit",
			{ inputSchemaRef: "builtin:uiSubmitRequest", effect: "write" as const },
		],
		[
			"ui-compositions.cancel",
			{ inputSchemaRef: "builtin:uiCancelRequest", effect: "write" as const },
		],
	]),
	queries: new Set([LIST, FORM]),
	inputAdapters: new Map([
		[
			INPUT,
			(raw: Record<string, unknown>) => {
				const values = uiResponseFields.safeParse(raw);
				return values.success
					? { ok: true as const, value: { values: values.data } }
					: {
							ok: false as const,
							errors: [{ field: "values", message: "入力を確認してください" }],
						};
			},
		],
	]),
	projections: new Set(["projection:ui-compositions.result@1"]),
	availability: "availability:ui-compositions@1",
});

export function createUiCompositionsAdapter(
	service: UiCompositionsService,
): DomainAdapter {
	function result(
		receipt: { projectId: string; state: string; responseId?: string },
		requestId: string,
		replay: boolean,
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "ui-compositions",
				operationId: requestId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [
				{
					owner: "ui-compositions",
					kind: "composition",
					id: receipt.projectId,
					schemaRef: "domain:ui-compositions.receipt@1",
				},
			],
			replay,
			answerContext: { projectId: receipt.projectId, state: receipt.state },
		};
	}
	return {
		ref: UI_COMPOSITIONS_ADAPTER_REF,
		describe: describeUiCompositionsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (db) => ({
			items: service
				.listInTransaction(db)
				.map(({ id, title, state, generation }) => ({
					id,
					title,
					state,
					generation,
				})),
		}),
		invokeInTransaction(db, request) {
			if (request.operationName === "ui-compositions.compose") {
				const outcome = service.composeInTransaction(
					db,
					uiComposeRequest.parse(request.input),
					request.requestId,
				);
				return result(outcome.receipt, request.requestId, outcome.replay);
			}
			if (request.operationName === "ui-compositions.submit") {
				const input = uiSubmitRequest.parse(request.input);
				const outcome = service.submitInTransaction(
					db,
					input.projectId,
					input.expectedGeneration,
					input.values,
					request.requestId,
				);
				return result(outcome.receipt, request.requestId, outcome.replay);
			}
			if (request.operationName === "ui-compositions.cancel") {
				const input = uiCancelRequest.parse(request.input);
				const outcome = service.cancelInTransaction(
					db,
					input.projectId,
					request.requestId,
				);
				return result(outcome.receipt, request.requestId, outcome.replay);
			}
			throw new Error("ui_operation_unknown");
		},
		readInTransaction(db, operationId) {
			const saved = service.receiptInTransaction(db, operationId);
			return saved ? result(saved, operationId, true) : null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query === LIST && targetRef === undefined) {
				const items = service.listInTransaction(db);
				return {
					revision: Math.max(0, ...items.map((item) => item.updatedAt)),
					data: { kind: "ui-workspace", items, images: [] },
				};
			}
			if (query === FORM && targetRef) {
				const project = service.getInTransaction(db, targetRef);
				if (
					!project ||
					project.state !== "ready" ||
					!Array.isArray(project.fields)
				)
					return null;
				return {
					revision: project.generation,
					data: {
						kind: "form",
						fields: project.fields,
						defaults: {},
						submitLabel: "送信",
					},
				};
			}
			return null;
		},
		targetInput(query, targetRef, revision) {
			return query === FORM
				? { projectId: targetRef, expectedGeneration: revision }
				: {};
		},
		afterCommit: service.wake,
	};
}
