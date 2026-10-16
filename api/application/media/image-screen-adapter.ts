import type { Database } from "bun:sqlite";
import { imageListInTransaction } from "../../domains/image";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const IMAGE_SCREEN_ADAPTER_REF = "adapter:image-screen@1";
const IMAGE_LIST = "query:image-screen.list@1";

/** The screen registers an image-owned source; generation uses the conversation API. */
export const describeImageScreenAdapter = () => ({
	owner: "image",
	operations: new Map(),
	queries: new Set([IMAGE_LIST]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:image-screen@1",
});

export function createImageScreenAdapter(): DomainAdapter {
	return {
		ref: IMAGE_SCREEN_ADAPTER_REF,
		describe: describeImageScreenAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: () => {
			throw new Error("unsupported_operation");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx: Database, query, targetRef) {
			if (query !== IMAGE_LIST || targetRef !== undefined) return null;
			const items = imageListInTransaction(tx, "main");
			return {
				revision: Math.max(0, ...items.map((item) => item.updatedAt)),
				data: { items },
			};
		},
		targetInput: () => ({}),
	};
}
