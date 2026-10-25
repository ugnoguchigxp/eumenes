import type { Database } from "bun:sqlite";
import type { HostTodo } from "eumenes-agency";
import type { DialogueService } from "../../domains/dialogue";

/** Characters of one TODO line (the agency prompt stays short). */
export const TODO_TITLE_CHARS = 60;
/** Characters of one result line. */
export const TODO_RESULT_CHARS = 200;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type LedgerTodo = ReturnType<DialogueService["todosInTransaction"]>[number];

const TEXT_FIELDS = ["answer", "summary", "text", "message", "title", "name"];

/** The result of finished work as one line: its own words where it has them, else its data. */
export function resultLine(result: unknown): string | undefined {
	if (result === null || result === undefined) return undefined;
	if (typeof result === "string") return oneLine(result, TODO_RESULT_CHARS);
	if (typeof result === "object" && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		for (const key of TEXT_FIELDS)
			if (typeof record[key] === "string" && record[key].trim())
				return oneLine(record[key], TODO_RESULT_CHARS);
		// A research report: its claims are the result.
		if (Array.isArray(record.claims)) {
			const claims = record.claims.flatMap((claim) =>
				claim && typeof claim === "object" && typeof claim.text === "string"
					? [claim.text]
					: [],
			);
			if (claims.length) return oneLine(claims.join(" "), TODO_RESULT_CHARS);
		}
	}
	return oneLine(JSON.stringify(result), TODO_RESULT_CHARS);
}

/**
 * A TODO as the agency sees it: open work, a question the sub-agent asks the user, or finished work with its result.
 * Work the user cancelled is not reported back.
 */
export function hostTodoOf(item: LedgerTodo): HostTodo | null {
	const base = {
		id: item.id,
		title: oneLine(item.title, TODO_TITLE_CHARS),
		requestedAt: Date.parse(item.createdAt),
	};
	if (item.status === "todo") return { ...base, status: "todo" };
	if (item.status === "waiting")
		return {
			...base,
			status: "waiting",
			question: oneLine(item.question ?? "", TODO_RESULT_CHARS),
		};
	if (item.outcome === "cancelled") return null;
	const result = resultLine(item.result);
	return {
		...base,
		status: "done",
		outcome:
			item.outcome === "succeeded" || item.outcome === "partial"
				? item.outcome
				: "failed",
		...(result ? { result } : {}),
		doneAt: Date.parse(item.changedAt),
	};
}

/**
 * The agency's view of a conversation's TODOs (the dialogue ledger, spec ContextWindow section 9): open work,
 * questions to ask and finished work to report. The agency reports what finished and asks what the work asks.
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
