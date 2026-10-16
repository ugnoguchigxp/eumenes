import { createHash } from "node:crypto";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { ocrListInTransaction, type OcrService } from "../../domains/ocr";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
export const OCR_ADAPTER_REF = "adapter:ocr@1";
const OCR_LIST = "query:ocr.list@1";
const OWNER = CONVERSATION_DEFAULT_PRINCIPAL;
export const describeOcrAdapter = () => ({
	owner: "ocr",
	operations: new Map([
		[
			"ocr.open",
			{ inputSchemaRef: "builtin:emptyInput", effect: "read" as const },
		],
		[
			"ocr.read",
			{ inputSchemaRef: "builtin:ocrTarget", effect: "read" as const },
		],
		[
			"ocr.cancel",
			{ inputSchemaRef: "builtin:ocrTarget", effect: "write" as const },
		],
	]),
	queries: new Set([OCR_LIST]),
	inputAdapters: new Map(),
	projections: new Set(["projection:ocr-result@1"]),
	availability: "availability:ocr@1",
});
function result(
	value: unknown,
	requestId: string,
	replay: boolean,
): AdapterResult {
	const digest = createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex");
	return {
		receipt: value,
		receiptRef: { owner: "ocr", operationId: requestId, digest },
		resultRefs: [],
		replay,
		answerContext: {
			kind: "ocr",
			result: JSON.stringify(value).slice(0, 30000),
			truncated: JSON.stringify(value).length > 30000,
		},
	};
}
export function createOcrAdapter(service: OcrService): DomainAdapter {
	return {
		ref: OCR_ADAPTER_REF,
		describe: describeOcrAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (db) => ({
			items: ocrListInTransaction(db, OWNER, "main").map((r) => ({
				id: r.id,
				name: r.name,
				state: r.state,
				frameTimes:
					r.result?.kind === "video"
						? r.result.frames.map((f) => f.timestampSeconds)
						: [],
			})),
		}),
		invokeInTransaction(db, request) {
			const operation = request.operationName.slice(4) as
				| "open"
				| "read"
				| "cancel";
			if (!describeOcrAdapter().operations.has(request.operationName))
				throw new Error("unsupported_operation");
			const input = request.input as { id?: string };
			const conversationId =
				request.origin.kind === "conversation"
					? request.origin.conversationId
					: "main";
			const saved = service.commandInTransaction(
				db,
				OWNER,
				conversationId,
				operation,
				input.id,
				request.requestId,
			);
			return result(saved.value, request.requestId, saved.replay);
		},
		readInTransaction(db, requestId) {
			const value = service.commandResultInTransaction(db, OWNER, requestId);
			return value ? result(value, requestId, true) : null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query !== OCR_LIST || targetRef !== undefined) return null;
			const items = ocrListInTransaction(db, OWNER, "main");
			return {
				revision: Math.max(0, ...items.map((item) => item.updatedAt)),
				data: { items },
			};
		},
		targetInput: () => ({}),
	};
}
