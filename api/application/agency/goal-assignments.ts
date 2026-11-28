import type { Database } from "bun:sqlite";
import type { AgendaNote, AgendaResearchTicket } from "../../domains/dialogue";
import type { AgendaScope } from "./always-on-scope";

/**
 * Registered goals reach the user as the agent's own assignments (spec/goal-results-as-assignments-2026-11-26.md):
 * each goal is an item of the conversation's agenda with this assignee. Its progress and question come from the
 * goal, and its report becomes a work-report note the agent tells in its own words, like any assignee's.
 */
export const GOAL_ASSIGNEE = "登録目標";

/** What a goal shows its conversation now: what it does, what it asks the user, or what it came to. */
export type GoalWorkView = {
	readonly goalId: string;
	readonly revision: number;
	readonly slot: number;
	/** The goal as the user registered it (its desired state). */
	readonly text: string;
	readonly conversationId: string;
	/** The user's words the goal rests on: the item rests on them, and goes when they are forgotten. */
	readonly sourceMessageId: string;
	readonly progress: string | null;
	readonly question: { readonly ref: string; readonly prompt: string } | null;
	/** The goal was met and its report is not told yet. */
	readonly report: {
		readonly id: string;
		readonly text: string;
		readonly checked: readonly string[];
		/** The material the report rests on: the note goes when it is forgotten. */
		readonly sources: readonly string[];
	} | null;
};

/** The host's goals as the agency sees them. */
export type GoalWorkPort = {
	viewsInTransaction(db: Database): readonly GoalWorkView[];
	/** When the goals' own quiet ends for a question it holds back now (null: none is held). */
	heldUntilInTransaction(db: Database): number | null;
	/** The report was made a note and is the agent's to tell: it is not delivered another way. */
	reportedInTransaction(db: Database, view: GoalWorkView): void;
	/** The user's answer, change or call-off, in words of theirs (`messageId`), handed to the goal. */
	control(input: {
		conversationId: string;
		view: GoalWorkView;
		action: "answer" | "amend" | "cancel";
		text: string | null;
		messageId: string;
		signal: AbortSignal;
	}): Promise<string>;
};

const goalKey = (view: Pick<GoalWorkView, "goalId" | "revision">) =>
	`${view.goalId}@${view.revision}`;
export const goalTicketOf = (
	c: AgendaScope,
	view: Pick<GoalWorkView, "goalId" | "revision">,
) =>
	c.tickets.find(
		({ goal }) =>
			goal?.goalId === view.goalId && goal.revision === view.revision,
	);

/**
 * Each goal of this conversation that goes on, or has a report to tell, is an item of the agent once: made from the
 * goal's own words (the message it rests on), so the agent's state lists it beside the user's other assignments.
 */
export function offerGoalItems(
	c: AgendaScope,
	views: readonly GoalWorkView[],
	now: number,
) {
	let changed = false;
	for (const view of views) {
		if (view.conversationId !== c.id || goalTicketOf(c, view)) continue;
		const made = c.agent.requestResearch({
			text: view.text,
			at: now,
			delegatedTo: GOAL_ASSIGNEE,
			userRef: { id: view.sourceMessageId },
		});
		// A duplicate is the open item of this goal (its ticket comes when the agent issues it).
		if ("item" in made) changed = true;
	}
	return changed;
}

/**
 * The agent issued the goal's item: it is held as a ticket of the goal, with no work started (the goal runs on its
 * own). The item's words name the goal; a goal that went meanwhile leaves the ticket unknown, and the item fails.
 */
export function goalTicket(
	ticket: {
		id: string;
		itemId: string;
		text: string;
		refs: readonly string[];
		at: number;
	},
	itemText: string,
	views: readonly GoalWorkView[],
	conversationId: string,
): AgendaResearchTicket | null {
	const view = views.find(
		(candidate) =>
			candidate.conversationId === conversationId &&
			candidate.text.trim() === itemText.trim(),
	);
	return view
		? {
				id: ticket.id,
				itemId: ticket.itemId,
				agentTicketId: ticket.id,
				revisionId: `goal:${goalKey(view)}`,
				question: view.text,
				at: ticket.at,
				refs: [...ticket.refs],
				inputs: [],
				goal: { goalId: view.goalId, revision: view.revision },
			}
		: null;
}

/** The goal's report as a work-report note, the same shape as an assignee's. */
export function goalNote(
	ticket: AgendaResearchTicket,
	view: GoalWorkView,
	at: number,
): AgendaNote {
	const report = view.report!;
	const title = `作業報告: ${view.text.replace(/\s+/gu, " ").slice(0, 50)}`;
	const body = [
		"## 依頼",
		view.text,
		"## 結果",
		report.text,
		...(report.checked.length
			? ["## 確かめたこと", ...report.checked.map((line) => `- ${line}`)]
			: []),
	].join("\n\n");
	return {
		id: `n${crypto.randomUUID().slice(0, 8)}`,
		title,
		summary: report.text.replace(/\s+/gu, " ").slice(0, 200),
		markdown: `# ${title}\n\n${body}`,
		at,
		refs: [...ticket.refs],
		ticketId: ticket.id,
		inputs: [...report.sources],
	};
}
