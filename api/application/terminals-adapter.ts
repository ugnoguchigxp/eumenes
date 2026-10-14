import type { TerminalsService } from "../domains/terminals";
import type { DomainAdapter } from "../domains/tool-runtime";

export const TERMINALS_ADAPTER_REF = "adapter:terminals@1";
const SESSIONS = "query:terminals.sessions@1";

/** Registers the session list; PTY input, output and lifecycle use the authenticated terminal API. */
export const describeTerminalsAdapter = () => ({
	owner: "terminals",
	operations: new Map(),
	queries: new Set([SESSIONS]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:terminals@1",
});

export function createTerminalsAdapter(
	terminals: Pick<TerminalsService, "available" | "list">,
): DomainAdapter {
	return {
		ref: TERMINALS_ADAPTER_REF,
		describe: describeTerminalsAdapter,
		availableInTransaction: () => terminals.available(),
		snapshotInTransaction: () => ({}),
		invokeInTransaction: () => {
			throw new Error("unsupported_operation");
		},
		readInTransaction: () => null,
		sourceInTransaction(_tx, query, targetRef) {
			if (query !== SESSIONS || targetRef !== undefined) return null;
			const list = terminals.list();
			return { revision: list.revision, data: list };
		},
		targetInput: () => ({}),
	};
}
