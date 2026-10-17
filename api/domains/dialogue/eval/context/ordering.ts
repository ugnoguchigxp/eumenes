/**
 * The ordering variant for measurement (ContextWindow design section 4.1, W1). O1 is today's order, `S P [kept] W
 * [unprocessed] V R`; O2 puts the working memory after all of the history, `S P [kept + unprocessed] W V R`, so a
 * change of W leaves the history in the shared prefix. Applied to a finished render, it moves the messages that sit
 * between the first and the last history message (the working memory) behind the last one. Nothing else moves, so
 * the session split and the position of the request are unchanged.
 */
import type { ChatMessage } from "../../service/context";
import type { ArmOutput, ContextArm } from "./arm";
import { historyIndexes } from "./render-invariants";

export type Ordering = "O1" | "O2";

export function applyOrdering(
	ordering: Ordering,
	assembly: Parameters<ContextArm["build"]>[0],
	out: ArmOutput,
): ArmOutput {
	if (ordering === "O1") return out;
	const history = historyIndexes(assembly.history.turns, out.messages);
	if (!history || history.length < 2) return out;
	const first = history[0]!;
	const last = history[history.length - 1]!;
	const inHistory = new Set(history);
	const between: ChatMessage[] = [];
	const messages: ChatMessage[] = [];
	for (const [i, message] of out.messages.entries()) {
		if (i > first && i < last && !inHistory.has(i)) between.push(message);
		else {
			messages.push(message);
			if (i === last) messages.push(...between);
		}
	}
	// `between` is complete before `last` is reached, so the moved messages land right after it.
	return { ...out, messages };
}

/** `arm` rendered in another order, as its own arm id (a measurement variant, not a judged arm). */
export function orderingVariant(
	arm: ContextArm,
	id: string,
	ordering: Ordering,
): ContextArm {
	return {
		...arm,
		id,
		build: (assembly) => applyOrdering(ordering, assembly, arm.build(assembly)),
	};
}
