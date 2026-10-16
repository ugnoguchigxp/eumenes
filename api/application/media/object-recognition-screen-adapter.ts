import type { Database } from "bun:sqlite";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { recognitionListInTransaction } from "../../domains/object-recognition";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const OBJECT_RECOGNITION_SCREEN_ADAPTER_REF =
	"adapter:object-recognition-screen@1";
const RECOGNITION_LIST = "query:object-recognition-screen.list@1";

/** Registers the owner-scoped source; media and actions use the existing authenticated API. */
export const describeObjectRecognitionScreenAdapter = () => ({
	owner: "object-recognition",
	operations: new Map(),
	queries: new Set([RECOGNITION_LIST]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:object-recognition-screen@1",
});

export function createObjectRecognitionScreenAdapter(): DomainAdapter {
	return {
		ref: OBJECT_RECOGNITION_SCREEN_ADAPTER_REF,
		describe: describeObjectRecognitionScreenAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: () => {
			throw new Error("unsupported_operation");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx: Database, query, targetRef) {
			if (query !== RECOGNITION_LIST || targetRef !== undefined) return null;
			const items = recognitionListInTransaction(
				tx,
				CONVERSATION_DEFAULT_PRINCIPAL,
				"main",
			);
			return {
				revision: Math.max(0, ...items.map((item) => item.updatedAt)),
				data: { items },
			};
		},
		targetInput: () => ({}),
	};
}
