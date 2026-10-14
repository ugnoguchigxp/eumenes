import { addGoalTodo, putRoute } from "../../repository";
import type { StepEnv } from "../types";
import type { CurateContext, Route } from "./curate-types";

/**
 * Section 3.4 of the World plan: what curate-memory judged of each exchange it settled. The judgment is kept per
 * message, bound to the revision and digest the model read, so the World step of a corrected message (another
 * version) never trusts it. An exchange the model did not judge counts as needing both steps. The goal reflection
 * is due for every exchange whose goals judgment is not `false`.
 */
export function recordRoutes(
	env: StepEnv,
	context: CurateContext,
	route: readonly Route[],
) {
	const { db, deps, conversationId } = env;
	if (!deps.world && !deps.goals) return;
	const now = deps.clock();
	const judged = new Map(route.map((entry) => [entry.exchange, entry]));
	const targets = new Set(context.targetIds);
	// A forget of this very unit may have blocked an exchange: nothing is routed for it.
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		Object.values(context.exchanges).flatMap((e) =>
			[e.inputMessageId, e.answerMessageId].filter(
				(id): id is string => id !== null,
			),
		),
	);
	for (const [label, exchange] of Object.entries(context.exchanges)) {
		if (!targets.has(exchange.inputMessageId)) continue;
		if (blocked.has(exchange.inputMessageId)) continue;
		const verdict = judged.get(label);
		const world = verdict?.world ?? true;
		const goals = verdict?.goals ?? true;
		for (const id of [exchange.inputMessageId, exchange.answerMessageId]) {
			const source = id === null ? undefined : context.sources[id];
			if (id === null || !source || blocked.has(id)) continue;
			putRoute(
				db,
				{
					messageId: id,
					revision: source.revision,
					digest: source.digest,
					conversationId,
					world,
					goals,
				},
				now,
			);
		}
		if (deps.goals && goals)
			addGoalTodo(db, conversationId, exchange.inputMessageId);
	}
}
