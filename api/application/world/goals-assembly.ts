import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
} from "../../domains/conversation";
import { createGoalsService } from "../../domains/goals";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** The Scope the conversation's goals live in (the same one World and its readers use). */
export const GOALS_ACCESS = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKeys: [CONVERSATION_DEFAULT_SCOPE],
} as const;

/** The goals service. */
export function createGoalsAssembly(store: SqliteStore) {
	return { goals: createGoalsService(store) };
}
