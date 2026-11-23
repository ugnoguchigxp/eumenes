import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import { listExclusions } from "eumenes-memory/sqlite";
import { PRINCIPAL, PROFILE_SCOPE } from "../../memory/contracts";
import type { StewardDeps } from "./types";

/** The access the library checks, with the policy revision as it stands in this transaction. */
function libraryAccess(db: Database, deps: StewardDeps): AccessContext {
	return {
		principal: PRINCIPAL,
		scopeKeys: [PROFILE_SCOPE],
		purpose: "memory.consolidation",
		policyRevision: deps.memory.policyRevisionInTransaction(db),
	};
}

/**
 * The state items the library holds as excluded (a forget excluded them at once and its closure delete has not
 * removed them yet).
 */
export function excludedTargets(
	db: Database,
	deps: StewardDeps,
): { itemIds: string[] } {
	const listed = listExclusions(db, {
		contractVersion: 2,
		access: libraryAccess(db, deps),
		scopeKey: PROFILE_SCOPE,
	});
	if (listed.status !== "ok") return { itemIds: [] };
	return {
		itemIds: listed.targets.flatMap((target) =>
			target.type === "state_item" ? [target.itemId] : [],
		),
	};
}
