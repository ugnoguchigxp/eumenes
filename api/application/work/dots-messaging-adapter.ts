import type { DomainAdapter } from "../../domains/tool-runtime";
import type { DotsMessages } from "./dots-messages";
export const DOTS_MESSAGING_ADAPTER_REF = "adapter:dots-messaging@1";
export const describeDotsMessagingAdapter = () => ({
	owner: "dots",
	operations: new Map(),
	queries: new Set(["query:dots-messaging.view@1"]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:dots-messaging@1",
});
export function createDotsMessagingAdapter(
	messages: DotsMessages,
): DomainAdapter {
	return {
		ref: DOTS_MESSAGING_ADAPTER_REF,
		describe: describeDotsMessagingAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction: () => {
			throw new Error("unsupported_operation");
		},
		readInTransaction: () => null,
		targetInput: () => ({}),
		sourceInTransaction(db, query, target) {
			if (query !== "query:dots-messaging.view@1") return null;
			const data = target ? messages.viewInTransaction(db, target) : null;
			return {
				revision: data?.thread.revision ?? 0,
				data: data ?? { items: [] },
			};
		},
	};
}
