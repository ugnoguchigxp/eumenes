import type { Database } from "bun:sqlite";
import { createPlans } from "./plans";
import { createMaintenance, type MaintenanceOptions } from "./maintenance";
import { stateTokenOf } from "./registry";
import * as repo from "../repository";

// Kept for the old management API. New route learning and execution are retired.
export type EditResult =
	| { kind: "not_found" }
	| { kind: "conflict"; code: string }
	| { kind: "not_editable" };
export function createResearchRoutes(opts: MaintenanceOptions = {}) {
	return {
		...createPlans(opts),
		...createMaintenance(opts),
		editInTransaction(
			db: Database,
			input: { key: string; expectedStateToken: string; instruction: string },
		): EditResult {
			const row = repo.getKey(db, repo.getEpoch(db), input.key);
			if (!row) return { kind: "not_found" };
			if (stateTokenOf(row) !== input.expectedStateToken)
				return { kind: "conflict", code: "stale_state_token" };
			return { kind: "not_editable" };
		},
	};
}
export type ResearchRoutes = ReturnType<typeof createResearchRoutes>;
export { type Clock } from "./registry";
export { type ControlResult } from "./plans";
export {
	createOperations,
	type ApiResult,
	type OperationsDeps,
	type RouteChange,
	type RouteOperations,
	type SkillReader,
} from "./operations";
