import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { touchesSuppressedTerm } from "../../memory";
import type { PlanItem } from "../../continuity";
import type { DialogueDeps } from "./context";
import { lineText } from "./input-text";

/** The plans and goals together may take this many tokens of `## State` (its own bound is 600; section 7.1). */
export const PLAN_GOAL_TOKENS = 150;

/**
 * The topic words the user asked not to be brought up. None without memory (nothing can have been asked); null when
 * memory cannot say: the fields are then not shown (a topic that may be one to leave out is not brought up).
 */
function suppressedTerms(deps: DialogueDeps, tx: Database): string[] | null {
	if (!deps.memory) return [];
	try {
		return deps.memory.suppressionsInTransaction(tx).terms;
	} catch {
		return null;
	}
}

function planLine(plan: PlanItem, index: number): string {
	const notes = [
		plan.dueAt,
		plan.state === "awaiting_confirmation" ? "確認待ち" : null,
	].filter((note): note is string => !!note);
	return `- p${index + 1} ${lineText(plan.text)}${notes.length ? `（${notes.join("、")}）` : ""}`;
}

/**
 * The plans with a date (L3: open or waiting for the user's word) and the goals in the agenda's slots, as `## State`
 * shows them (the redesign, section 7.1): the soonest plans first, the goals in slot order, cut at
 * `PLAN_GOAL_TOKENS` together. The continuity leaves out a plan that rests on a forgotten or excluded source, the
 * agency a goal; one that names a topic the user asked not to be brought up is left out here.
 */
export function planGoalLines(deps: DialogueDeps, tx: Database): string[] {
	const terms = suppressedTerms(deps, tx);
	if (terms === null) return [];
	const allowed = (text: string) => !touchesSuppressedTerm(terms, text);
	const plans = deps.continuity.plans
		.listInTransaction(tx, { kinds: ["plan", "intent"] })
		.filter((plan) => allowed(plan.text))
		.map(planLine);
	const goals = (deps.agency?.goalSlotsInTransaction?.(tx) ?? [])
		.filter((goal) => allowed(goal.text))
		.map(
			(goal) =>
				`- 枠${goal.slot} ${lineText(goal.text)}（${lineText(goal.state)}）`,
		);
	const tokens = (lines: readonly string[]) =>
		estimateTextTokens(lines.join("\n"));
	/** The lines of one field that fit in what is left, in order. */
	const fit = (heading: string, lines: readonly string[], left: number) => {
		const kept: string[] = [];
		for (const line of lines) {
			if (tokens([heading, ...kept, line]) > left) break;
			kept.push(line);
		}
		return kept.length ? [heading, ...kept] : [];
	};
	// The goals keep room for their first line: a full list of plans does not take every goal away.
	const reserved = goals.length ? tokens(["目標:", goals[0]!]) : 0;
	const planField = fit("予定:", plans, PLAN_GOAL_TOKENS - reserved);
	const goalField = fit(
		"目標:",
		goals,
		PLAN_GOAL_TOKENS - (planField.length ? tokens(planField) : 0),
	);
	return [...planField, ...goalField];
}
