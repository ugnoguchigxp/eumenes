import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import { resultText } from "./result-text";
import { madeOf } from "./state-text";

/** How the recent conversation marks a host notice: it is the host's, neither the user's words nor the agent's. */
export const NOTICE_MARK = "[ホストの知らせ]";

/**
 * The host notice a report answered, in one line: which work ended and how, and what it made (the tool-call
 * reliability design, section 5.5 #4). The recent conversation shows it before the report, so the report reads as
 * the answer to a notice, never as the answer to a request (a reply that said "できあがりました" to a request was
 * copied from such a report). Null when none of the works is known.
 */
export function reportNoticeInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	workIds: readonly string[],
): string | null {
	const ledger = deps.work;
	if (!ledger || !workIds.length) return null;
	const refs = ledger.refsInTransaction(tx, conversationId);
	const todos = ledger.todosInTransaction(tx, conversationId);
	const heads = workIds.flatMap((id) => {
		const row = ledger.workInTransaction(tx, id);
		const ref = refs.todo(id);
		if (!row || !ref) return [];
		const made = todos
			.filter((todo) => todo.id === id)
			.flatMap((todo) => madeOf(todo, refs));
		const head = resultText({
			ref,
			title: row.title,
			status: row.status,
			...(row.outcome ? { outcome: row.outcome } : {}),
			...(row.question ? { question: row.question } : {}),
			result: row.result,
			made,
			resource: refs.resource,
		}).text.split("\n")[0]!;
		return [made.length ? `${head}作った物 ${made.join(" ")}` : head];
	});
	return heads.length ? `${NOTICE_MARK} ${heads.join(" ")}` : null;
}
