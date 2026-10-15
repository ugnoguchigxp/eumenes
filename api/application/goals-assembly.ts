import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
} from "../domains/conversation";
import type { GoalsLayerPort } from "../domains/dialogue";
import {
	createGoalsService,
	existingGoalIdsInTransaction,
} from "../domains/goals";
import type { SqliteStore } from "../infrastructure/sqlite";

/** The Scope the conversation's goals live in (the same one World and its readers use). */
export const GOALS_ACCESS = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKeys: [CONVERSATION_DEFAULT_SCOPE],
} as const;

/** The goals service and the port the conversation reads its goals layer through. */
export function createGoalsAssembly(store: SqliteStore) {
	const goals = createGoalsService(store);
	const dialoguePort: GoalsLayerPort = {
		adoptedForContextInTransaction: (db) =>
			goals.adoptedForContextInTransaction(db, GOALS_ACCESS),
		existingInTransaction: existingGoalIdsInTransaction,
	};
	return { goals, dialoguePort };
}
