import type { Database } from "bun:sqlite";
import type { HostTodo } from "eumenes-agency";
import type { DialogueService } from "../../domains/dialogue";

/** Characters of one TODO line (the agency prompt stays short). */
export const TODO_TITLE_CHARS = 60;
/** Characters of one question line. */
export const TODO_QUESTION_CHARS = 200;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type LedgerTodo = ReturnType<DialogueService["todosInTransaction"]>[number];

/**
 * A TODO as the agency sees it: open work, or a question the sub-agent asks the user. The title names the toolchain
 * the work went to (`[画像の作成] …`), so the agency knows what kind of work it was. Finished work is archived as it
 * finishes and told by its notice on screen: the agency is never given it (the TODO completion notice design).
 */
export function hostTodoOf(item: LedgerTodo): HostTodo | null {
	const base = {
		id: item.id,
		title: oneLine(
			item.toolchainTitle
				? `[${item.toolchainTitle}] ${item.title}`
				: item.title,
			TODO_TITLE_CHARS,
		),
		requestedAt: Date.parse(item.createdAt),
	};
	if (item.status === "todo") return { ...base, status: "todo" };
	if (item.status === "waiting")
		return {
			...base,
			status: "waiting",
			question: oneLine(item.question ?? "", TODO_QUESTION_CHARS),
		};
	return null;
}

/**
 * The agency's view of a conversation's TODOs (the dialogue ledger, spec ContextWindow section 9): open work and the
 * questions to ask.
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
