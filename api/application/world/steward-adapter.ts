import { z } from "zod";
import type { MemoryService } from "../../domains/memory";
import {
	type StewardService,
	memoryRequestInput,
	requestKinds,
} from "../../domains/steward";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";

export const STEWARD_ADAPTER_REF = "adapter:steward@1";
const REQUEST = "steward.request";
const RECEIPT = "domain:steward.receipt@1";

/** What the tool reports: the request was staged. It never carries the user's words. */
const stewardReceipt = z.strictObject({
	requestId: z.string(),
	kind: z.enum(requestKinds),
	staged: z.literal(true),
});
type StewardReceipt = z.infer<typeof stewardReceipt>;
export const stewardDomainSchemas = { [RECEIPT]: stewardReceipt };

/** The conversation agent's `memory_request`: one operation, no screen sources. */
export const describeStewardAdapter = () => ({
	owner: "steward",
	operations: new Map([
		[
			REQUEST,
			{ inputSchemaRef: "builtin:memoryRequest", effect: "write" as const },
		],
	]),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set(["projection:steward.result@1"]),
	availability: "availability:steward@1",
});

export function createStewardAdapter(
	steward: Pick<
		StewardService,
		"stageRequestInTransaction" | "requestInTransaction"
	>,
	memory: Pick<MemoryService, "readyInTransaction">,
): DomainAdapter {
	function result(receipt: StewardReceipt, replay: boolean): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "steward",
				operationId: receipt.requestId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [
				{
					owner: "steward",
					kind: "memory-request",
					id: receipt.requestId,
					schemaRef: RECEIPT,
				},
			],
			replay,
			// Accepting is not doing: the steward acts after the answer, and tells the next turn.
			answerContext: {
				accepted: true,
				kind: receipt.kind,
				executed: false,
				reportedBeforeNextTurn: true,
			},
		};
	}
	return {
		ref: STEWARD_ADAPTER_REF,
		describe: describeStewardAdapter,
		availableInTransaction: (tx) => memory.readyInTransaction(tx),
		snapshotInTransaction: () => ({}),
		invokeInTransaction(tx, request) {
			if (request.operationName !== REQUEST)
				throw new Error("unsupported_operation");
			// A request is the conversation agent's: the screens have no way to make one.
			if (
				request.origin.kind !== "conversation" &&
				request.origin.kind !== "task"
			)
				throw new Error("unsupported_origin");
			const parsed = memoryRequestInput.safeParse(request.input);
			if (!parsed.success) throw new Error("invalid_input");
			const staged = steward.stageRequestInTransaction(tx, {
				requestId: request.requestId,
				conversationId: request.origin.conversationId,
				runId: request.origin.runId,
				messageId: request.origin.messageId,
				kind: parsed.data.kind,
				what: parsed.data.what,
				detail: parsed.data.detail,
			});
			return result(
				{ requestId: staged.id, kind: parsed.data.kind, staged: true },
				staged.replay,
			);
		},
		readInTransaction(tx, operationId) {
			const found = steward.requestInTransaction(tx, operationId);
			return found
				? result({ requestId: found.id, kind: found.kind, staged: true }, true)
				: null;
		},
		sourceInTransaction: () => null,
		targetInput: () => ({}),
	};
}
