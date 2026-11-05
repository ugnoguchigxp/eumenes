import { askBack, type Step } from "./routed-actions";
import { MEMORY_REQUEST, fillMessages, fillSchema } from "./routed-choice";
import type { RouteCandidate } from "./routed-route";
import { styleOf } from "./routed-search";
import type { Turn } from "./routed-turn";
import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");

/**
 * The chosen candidate's fields (spec router-package-integration 2026-11-04 §1 #14): a toolchain that takes no
 * inputs and works on no saved item needs none; any other, and a memory request, is filled by the one-candidate call
 * of the conversation model, the only model call a router turn may still make (LARM's context judgment chooses, it
 * does not extract).
 */
export type Filled = { fields: Record<string, unknown> } | { step: Step };

type Target =
	Extract<RouteCandidate, { kind: "toolchain" | "read" }> | "memory";

/** The fields of the target for `text`. */
export function fieldsOf(
	turn: Turn,
	text: string,
	target: Target,
): Promise<Filled> {
	if (target !== "memory") {
		const { choice } = target;
		const inputs = choice.inputs as { properties?: object } | undefined;
		// The word that lets the suspended unsaved work go is read by the conversation model alone.
		if (
			turn.routed!.switching !== choice.id &&
			!inputs?.properties &&
			!choice.targets?.length
		)
			return Promise.resolve({ fields: {} });
	}
	return fill(turn, text, target);
}

/** The conversation model fills the one candidate's fields (it may also find nothing to ask for, or ask back). */
async function fill(turn: Turn, text: string, target: Target): Promise<Filled> {
	const routed = turn.routed!;
	const candidate = target === "memory" ? MEMORY_REQUEST : target.choice;
	const chosen = await turn.choose(
		fillMessages({ style: styleOf(turn), routed, candidate, utterance: text }),
		fillSchema(candidate, routed),
	);
	log.info("dialogue.choice_made", {
		kind: "fill",
		decision:
			chosen === "cut" || !chosen
				? "unreadable"
				: chosen.choice === "ask"
					? "ask"
					: chosen.choice === "none"
						? "none"
						: "fill",
	});
	if (chosen === "cut" || !chosen || chosen.choice === "none")
		return { step: "talk" };
	if (chosen.choice === "ask")
		return {
			step: askBack(turn, typeof chosen.say === "string" ? chosen.say : ""),
		};
	if (chosen.choice !== (target === "memory" ? MEMORY_REQUEST : target.id))
		return { step: "talk" };
	return { fields: chosen };
}
