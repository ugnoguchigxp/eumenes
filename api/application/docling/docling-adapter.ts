import { createHash } from "node:crypto";
import { doclingPrepared, type DoclingService } from "../../domains/docling";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";

export const DOCLING_ADAPTER_REF = "adapter:docling@1";
export const doclingDomainSchemas = {
	"domain:docling.prepared@1": doclingPrepared,
};
export const describeDoclingAdapter = () => ({
	owner: "docling",
	operations: new Map([
		[
			"docling.prepare",
			{ inputSchemaRef: "builtin:emptyInput", effect: "read" as const },
		],
	]),
	queries: new Set(["query:docling.launcher@1"]),
	inputAdapters: new Map(),
	projections: new Set(["projection:docling.prepared@1"]),
	availability: "availability:docling@1",
});

export function createDoclingAdapter(service: DoclingService): DomainAdapter {
	const result = (): AdapterResult => {
		const receipt = service.prepare();
		return {
			receipt,
			receiptRef: {
				owner: "docling",
				operationId: "launcher",
				digest: createHash("sha256")
					.update(JSON.stringify(receipt))
					.digest("hex"),
			},
			resultRefs: [],
			replay: false,
			answerContext: {
				kind: "docling",
				result: JSON.stringify(receipt),
				truncated: false,
			},
		};
	};
	return {
		ref: DOCLING_ADAPTER_REF,
		describe: describeDoclingAdapter,
		availableInTransaction: () => service.status().configured,
		artifactAvailableInTransaction: () => true,
		snapshotInTransaction: () => ({
			purpose: "Docling Deskの既存UIを別タブで開く入口。文書変換は実行しない。",
		}),
		invokeInTransaction(_db, request) {
			if (request.operationName !== "docling.prepare")
				throw new Error("unsupported_operation");
			return result();
		},
		// The prepared launcher is an immutable read, with no external mutation or secret.
		readInTransaction: (_db, id) =>
			id === "launcher" ? { ...result(), replay: true } : null,
		sourceInTransaction(_db, query, target) {
			return query === "query:docling.launcher@1" && target === undefined
				? { revision: service.status().revision, data: service.status() }
				: null;
		},
		targetInput: () => ({}),
	};
}
