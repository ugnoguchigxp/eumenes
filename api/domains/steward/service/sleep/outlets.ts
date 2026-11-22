import type { Database } from "bun:sqlite";
import { getLogger } from "../../../../infrastructure/logger";
import type { StewardDeps } from "../types";
import type { SleepOutlets } from "./ports";
import { saveGoalFindings, saveUnresolved } from "./questions";

const log = getLogger("steward");

/** An outlet whose place is not built yet: the instructions are logged by count and kept nowhere. */
const logged = (kind: string) => (_db: Database, items: readonly unknown[]) => {
	if (items.length > 0)
		log.info("steward.sleep_instruction_unrouted", {
			reason: "outlet_not_connected",
			kind,
			count: items.length,
		});
};

/**
 * The outlets the steward starts with. The plans go to `continuity` (L3). The unresolved contradictions and the
 * goal findings become open questions there (`questions.ts`), which the agent reads as plans. The preparations
 * are not stored yet and the relinks are the agent's to follow from the memory's change feed: both are logged by
 * count. A tendency (L4) is written through the memory domain's `writeTendencyInTransaction` inside the library's
 * promoting transaction: a refusal throws, so the deep run that would promote into it is not adopted (nothing is
 * dismissed and lost).
 */
export function createSleepOutlets(deps: StewardDeps): SleepOutlets {
	const custom = deps.sleep?.outlets ?? {};
	return {
		plansDue:
			custom.plansDue ??
			((db, localNow) => {
				deps.continuity.plans.markDueAwaitingInTransaction(db, localNow);
			}),
		pruneClosedPlans:
			custom.pruneClosedPlans ??
			((db) => {
				deps.continuity.plans.pruneClosedInTransaction(db);
			}),
		unresolved:
			custom.unresolved ?? ((db, items) => saveUnresolved(db, deps, items)),
		prep: custom.prep ?? logged("prep"),
		goals:
			custom.goals ??
			((db, items, goals) => saveGoalFindings(db, deps, items, goals)),
		relinks: custom.relinks ?? logged("relinks"),
		writeTendency:
			custom.writeTendency ??
			((db, tendency) => {
				// Memory says why it refused in a code; the library's transaction rolls back on the throw.
				const written = deps.memory.writeTendencyInTransaction(db, tendency);
				if (written.status === "rejected")
					throw new Error(`tendency_${written.reason}`);
			}),
	};
}
