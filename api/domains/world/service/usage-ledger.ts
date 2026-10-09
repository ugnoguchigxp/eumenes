import type { Database } from "bun:sqlite";
import { isMemoryContractError } from "eumenes-memory";
import { isMemoryStoreError } from "eumenes-memory/sqlite";
import {
	deleteDependents,
	listDependentIdsByPrefix,
	listReleasePending,
	markReleasePending,
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

type ScopeLike = { principal: string; scopeKey: string };

/**
 * Asks Memory to drop these dependents. "unregistered" means Memory has no
 * edge left for them; "blocked" means it refused. A thrown MemoryStoreError or
 * MemoryContractError is treated like a refusal, never propagated.
 */
export type UnregisterDependents = (
	ids: readonly string[],
) => "unregistered" | "blocked";

/**
 * Releases the host rows of Memory dependents without ever failing the
 * caller's transaction: Memory is asked inside a SAVEPOINT; on success the
 * host rows go, otherwise they STAY, marked `release_pending`, for
 * `sweepReleasePending` to retry. Returns true when Memory released them.
 * Other (programming) errors still propagate.
 */
export function releaseScopeDependents(
	db: Database,
	scope: ScopeLike,
	ids: readonly string[],
	unregister: UnregisterDependents,
): boolean {
	if (ids.length === 0) return true;
	const savepoint = "world_release_dependents";
	let released = false;
	db.exec(`SAVEPOINT ${savepoint}`);
	try {
		released = unregister(ids) === "unregistered";
		db.exec(`RELEASE ${savepoint}`);
	} catch (error) {
		db.exec(`ROLLBACK TO ${savepoint}`);
		db.exec(`RELEASE ${savepoint}`);
		if (!(isMemoryStoreError(error) || isMemoryContractError(error)))
			throw error;
	}
	if (released) deleteDependents(db, scope.principal, scope.scopeKey, ids);
	else markReleasePending(db, scope.principal, scope.scopeKey, ids);
	return released;
}

/**
 * Host rows and Memory registrations of the Scope's usage receipts, removed:
 * a forget in the Scope invalidates what the receipts stood on. The Memory
 * dependents are unregistered through `unregister` (kept as `release_pending`
 * when Memory cannot take it now), so no permanent Memory orphan remains.
 */
export function forgetUsageInScope(
	db: Database,
	scope: ScopeLike,
	unregister: UnregisterDependents,
): number {
	const runs = purgeScopeUsage(db, scope.principal, scope.scopeKey);
	for (const runId of runs)
		releaseScopeDependents(
			db,
			scope,
			listDependentIdsByPrefix(
				db,
				scope.principal,
				scope.scopeKey,
				sliceDependentPrefix(scope, runId),
			),
			unregister,
		);
	return runs.length;
}

/**
 * Retries every dependent that is waiting for a Memory unregistration (oldest
 * first, at most `limit`). `unregisterFor` gives the Memory call for a Scope.
 * Safe to run any time and repeatedly; returns how many Memory released.
 */
export function sweepReleasePending(
	db: Database,
	limit: number,
	unregisterFor: (scope: ScopeLike) => UnregisterDependents,
): { released: number; stillPending: number } {
	const pending = listReleasePending(db, limit);
	const byScope = new Map<string, { scope: ScopeLike; ids: string[] }>();
	for (const row of pending) {
		const key = JSON.stringify([row.principal, row.scopeKey]);
		const entry = byScope.get(key) ?? {
			scope: { principal: row.principal, scopeKey: row.scopeKey },
			ids: [],
		};
		entry.ids.push(row.externalId);
		byScope.set(key, entry);
	}
	let released = 0;
	for (const { scope, ids } of byScope.values())
		if (releaseScopeDependents(db, scope, ids, unregisterFor(scope)))
			released += ids.length;
	return { released, stillPending: pending.length - released };
}
