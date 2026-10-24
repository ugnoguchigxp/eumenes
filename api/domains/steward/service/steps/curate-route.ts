import { addGoalTodo, putRoute } from "../../repository";
import type { StepEnv } from "../types";
import type { CurateContext, Route } from "./curate-types";

/**
 * Section 3.4 of the World plan: what curate-memory judged of each event it settled. The judgment is kept per
 * message, bound to the revision and digest the model read, so the World step of a corrected message (another
 * version) never trusts it. An event the model did not judge counts as needing both steps. The goal reflection
 * is due for every event whose goals judgment is not `false`.
 */
export function recordRoutes(
	env: StepEnv,
	context: CurateContext,
	route: readonly Route[],
) {
	const { db, deps, conversationId } = env;
	if (!deps.world && !deps.goals) return;
	const now = deps.clock();
	const judged = new Map(route.map((entry) => [entry.event, entry]));
	const targets = new Set(context.targetSeqs);
	// A forget of this very unit may have blocked an event's message: nothing is routed for it.
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		Object.values(context.events)
			.map((e) => e.messageId)
			.filter((id): id is string => id !== null),
	);
	for (const [label, event] of Object.entries(context.events)) {
		if (event.seq === null || !targets.has(event.seq)) continue;
		if (event.messageId !== null && blocked.has(event.messageId)) continue;
		const verdict = judged.get(label);
		const world = verdict?.world ?? true;
		const goals = verdict?.goals ?? true;
		const source =
			event.messageId === null ? undefined : context.sources[event.messageId];
		if (event.messageId !== null && source)
			putRoute(
				db,
				{
					messageId: event.messageId,
					revision: source.revision,
					digest: source.digest,
					conversationId,
					world,
					goals,
				},
				now,
			);
		if (deps.goals && goals) addGoalTodo(db, conversationId, event.seq);
	}
}
