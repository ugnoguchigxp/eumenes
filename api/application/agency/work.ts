import type { Database } from "bun:sqlite";
import type { HostTodo } from "eumenes-agency";
import type { DialogueService } from "../../domains/dialogue";

/** Characters of one TODO line (the agency prompt stays short). */
export const TODO_TITLE_CHARS = 60;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type LedgerTodo = ReturnType<DialogueService["todosInTransaction"]>[number];

/** An open TODO as the agency sees it: `todo` or `waiting` is still to do; finished ones are not offered. */
export function hostTodoOf(item: LedgerTodo): HostTodo | null {
	if (item.status === "done") return null;
	return {
		id: item.id,
		title: oneLine(item.title, TODO_TITLE_CHARS),
		status: "todo",
		requestedAt: Date.parse(item.createdAt),
	};
}

/**
 * The agency's view of a conversation's TODOs (the dialogue ledger, spec ContextWindow section 9): only the open
 * ones. Reporting finished work belongs to the conversation agent, so the agency never sees a result.
 */
export function createAgencyWork(deps: {
	dialogue: Pick<DialogueService, "todosInTransaction">;
}) {
	return {
		todosInTransaction(db: Database, conversationId: string): HostTodo[] {
			return deps.dialogue
				.todosInTransaction(db, conversationId)
				.flatMap((item) => hostTodoOf(item) ?? []);
		},
	};
}
export type AgencyWork = ReturnType<typeof createAgencyWork>;
