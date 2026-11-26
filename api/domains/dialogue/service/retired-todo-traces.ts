import type { Database } from "bun:sqlite";
import {
	dropRetiredTodoTraces,
	retiredTodoTraces,
} from "../repository/retired-todos";
import type { DialogueDeps } from "./context";

/** Forgets the research runs a dropped TODO named, at their owner (Pursuit and the Web research it read). */
export type RetiredResearchErase = (
	db: Database,
	runIds: readonly string[],
) => void;

/**
 * What the dropped TODO ledger made elsewhere is forgotten once, at startup (`dialogue/0049-drop-retired-todos`): the
 * short-term memory events a TODO's result was told in, and the research runs it named. Each kind leaves the list only
 * when it was forgotten; research waits while no owner is registered. Returns how many were forgotten.
 */
export function forgetRetiredTodoTracesInTransaction(
	deps: Pick<DialogueDeps, "continuity" | "clock">,
	db: Database,
	eraseResearch: RetiredResearchErase | undefined,
): number {
	const traces = retiredTodoTraces(db);
	let forgotten = 0;
	if (traces.events.length) {
		deps.continuity.events.forgetMessagesInTransaction(
			db,
			traces.events,
			deps.clock(),
		);
		dropRetiredTodoTraces(db, "event");
		forgotten += traces.events.length;
	}
	if (traces.research.length && eraseResearch) {
		eraseResearch(db, traces.research);
		dropRetiredTodoTraces(db, "research");
		forgotten += traces.research.length;
	}
	return forgotten;
}
