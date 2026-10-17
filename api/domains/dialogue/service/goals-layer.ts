import { systemContext } from "../../../infrastructure/system-context";
import type { Database } from "bun:sqlite";
import type { ContextBlock } from "../../inference";
import type { ContextGoalEntry, GoalsLayerPort } from "../contracts";
import type { ChatMessage } from "./context";

const GOALS_FRAME = systemContext(
	"dialogue.contexts.goals-layer.goals-frame",
	{},
);

/** One line of one goal: whitespace collapsed (a goal cannot start a new line of its own). */
export function goalLine(desiredState: string): string {
	return `- ${desiredState.replace(/\s+/g, " ").trim()}`;
}

export type GoalsLayer = {
	/** The layer as the context's content: the frame sentence as the header, the goal lines as the one section. */
	block: ContextBlock;
	/** The same layer as the message the `current` format writes. */
	message: ChatMessage;
	/** The goals the layer lists: all of them. */
	shown: Array<{ goalId: string; revision: number }>;
};

/**
 * The goals layer, right after L1: the adopted goals in priority order, one line each, none left out and none cut
 * (the memory and history budget of the window governs the size). A function of the goals alone (no time, no
 * counters), so unchanged goals give byte-identical text and the prompt cache holds. Null without goals.
 */
export function renderGoalsLayer(
	goals: readonly ContextGoalEntry[],
): GoalsLayer | null {
	if (goals.length === 0) return null;
	// Stable: goals of one priority keep the order the port gave (most recently revised first).
	const ordered = goals
		.map((goal, index) => ({ goal, index }))
		.sort((a, b) => b.goal.priority - a.goal.priority || a.index - b.index)
		.map(({ goal }) => goal);
	const items = ordered.map((goal) => goalLine(goal.desiredState));
	const content = [GOALS_FRAME, ...items].join("\n");
	return {
		block: {
			source: "goals",
			authority: "reference",
			freshness: "stable",
			body: { kind: "lines", header: GOALS_FRAME, sections: [{ items }] },
		},
		message: { role: "system", content },
		shown: ordered.map(({ goalId, revision }) => ({ goalId, revision })),
	};
}

/** What the run was prepared with; kept for the adoption check. Absent when the layer was empty. */
export type PreparedGoals = { goalIds: string[] };

/**
 * F9: only a goal FORGET invalidates a run that showed that goal. The run is stale when any goal its layer
 * listed no longer exists; revising, completing, withdrawing or re-prioritising a goal, or adopting another,
 * does not (the same rule as Memory: a publish never expires a running run, only a forget does).
 */
export function goalsLayerStale(
	goals: GoalsLayerPort | undefined,
	db: Database,
	prepared: PreparedGoals | undefined,
): boolean {
	if (!goals || !prepared || prepared.goalIds.length === 0) return false;
	const existing = goals.existingInTransaction(db, prepared.goalIds);
	return prepared.goalIds.some((id) => !existing.has(id));
}
