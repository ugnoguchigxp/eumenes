import { askBack, type Fields, type Step } from "./routed-actions";
import { fillMessages, fillSchema } from "./routed-choice";
import type { RouteCandidate } from "./routed-route";
import { styleOf } from "./routed-search";
import type { Turn } from "./routed-turn";

type Toolchain = Extract<RouteCandidate, { kind: "toolchain" }>;
export type WorkChoice =
	{ candidate: Toolchain; fields?: Fields } | { step: Step };

/** Multiple scores can describe the ingredients of one interactive work. The model chooses its phase. */
export async function chooseWholeWork(
	turn: Turn,
	words: string,
	proposed: Toolchain,
	offered: readonly RouteCandidate[],
): Promise<WorkChoice> {
	const sessions = offered.filter(
		(c): c is Toolchain =>
			c.kind === "toolchain" && c.card.execution === "session",
	);
	if (proposed.card.execution !== "pipeline" || sessions.length === 0)
		return { candidate: proposed };
	const candidates = [proposed, ...sessions];
	const choices = candidates.map((c) => c.choice);
	const components = offered.flatMap((c) =>
		(c.kind === "toolchain" || c.kind === "read") &&
		!candidates.some((owner) => owner.id === c.id)
			? [c.choice]
			: [],
	);
	const routed = turn.routed!;
	const answer = await turn.choose(
		fillMessages({
			style: styleOf(turn),
			routed,
			candidate: choices,
			components,
			utterance: words,
		}),
		fillSchema(choices, routed),
	);
	if (!answer || answer === "cut" || answer.choice === "none")
		return { step: "talk" };
	if (answer.choice === "ask")
		return {
			step: askBack(turn, typeof answer.say === "string" ? answer.say : ""),
		};
	const candidate = candidates.find((c) => c.id === answer.choice);
	if (!candidate) return { step: "talk" };
	return {
		candidate,
		// The execution planner always receives the whole original request, never a model's first-job summary.
		fields:
			candidate.card.execution === "pipeline" ? { request: words } : answer,
	};
}
