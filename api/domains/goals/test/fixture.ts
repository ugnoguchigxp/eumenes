import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createGoalsService } from "..";
import type {
	GoalAccess,
	AdoptGoal,
	ProposeGoal,
	AdoptProposal,
	UpdateGoal,
	GoalTransition,
	Goal,
} from "../contracts";

/** Convenience writers used only by the goal fixtures; production owns its transaction. */
export function createGoalsFixture(
	store: SqliteStore,
	...args: Parameters<typeof createGoalsService>
) {
	const service = createGoalsService(...args);
	return {
		...service,
		adopt: (access: GoalAccess, input: AdoptGoal) =>
			store.write((db) => service.adoptInTransaction(db, access, input)),
		propose: (access: GoalAccess, input: ProposeGoal) =>
			store.write((db) => service.proposeInTransaction(db, access, input)),
		adoptProposal: (access: GoalAccess, goalId: string, input: AdoptProposal) =>
			store.write((db) =>
				service.adoptProposalInTransaction(db, access, goalId, input),
			),
		update: (access: GoalAccess, goalId: string, input: UpdateGoal) =>
			store.write((db) =>
				service.updateInTransaction(db, access, goalId, input),
			),
		withdraw: (access: GoalAccess, goalId: string, input: GoalTransition) =>
			store.write((db) =>
				service.withdrawInTransaction(db, access, goalId, input),
			),
		complete: (access: GoalAccess, goalId: string, input: GoalTransition) =>
			store.write((db) =>
				service.completeInTransaction(db, access, goalId, input),
			),
		proposals: (access: GoalAccess): Goal[] =>
			store.readSnapshot((db) => service.proposalsInTransaction(db, access)),
	};
}
