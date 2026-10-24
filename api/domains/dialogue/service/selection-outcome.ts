import type { Database } from "bun:sqlite";
import type { SelectionOutcome } from "../../toolchain-history";
import type { DialogueDeps } from "./context";

export function traceOutcome(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	result: { outcome: SelectionOutcome; code?: string | null },
) {
	deps.toolchains?.settleSelectionInTransaction(tx, runId, result);
}
/** A run that ends without an adopted answer: failed, expired, interrupted or cancelled. */
export function traceFailure(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	type: string,
	code: string | null,
) {
	traceOutcome(deps, tx, runId, {
		outcome:
			type === "expired"
				? "expired"
				: type === "cancelled"
					? "cancelled"
					: "failed",
		code,
	});
}
