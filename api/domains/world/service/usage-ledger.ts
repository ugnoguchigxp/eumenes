import type { Database } from "bun:sqlite";
import {
	deleteDependents,
	listDependentIdsByPrefix,
	purgeScopeUsage,
} from "../repository/usage";
import { externalIdOf } from "./memory-adapter";

/**
 * Every Memory dependent registered for the Slice behind one run starts with
 * this prefix (`w1s-<40 hex>-` + the 32-input part number). Derived from the
 * Scope and the run id only, so a cancel or a forget finds them without the
 * prepared context.
 */
export function sliceDependentPrefix(
	scope: { principal: string; scopeKey: string },
	runId: string,
): string {
	const first = externalIdOf("s", scope.principal, scope.scopeKey, [runId], 0);
	return first.slice(0, first.lastIndexOf("-") + 1);
}

/** Host rows only: the usage receipts of a Scope and the dependents they registered. */
export function forgetUsageInScope(
	db: Database,
	scope: { principal: string; scopeKey: string },
): number {
	const runs = purgeScopeUsage(db, scope.principal, scope.scopeKey);
	for (const runId of runs)
		deleteDependents(
			db,
			scope.principal,
			scope.scopeKey,
			listDependentIdsByPrefix(
				db,
				scope.principal,
				scope.scopeKey,
				sliceDependentPrefix(scope, runId),
			),
		);
	return runs.length;
}
