export { migrations } from "./repository";
export type { GoalsService } from "./service";
export { createGoalsService, goalRevisionOf } from "./service";
export type {
	GoalAccess,
	GoalOp,
	GoalOpResult,
	GoalStatus,
	StewardGoal,
} from "./contracts";
export { MAX_PROPOSED_GOALS } from "./contracts";
