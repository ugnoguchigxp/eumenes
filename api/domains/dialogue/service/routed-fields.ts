import { askBack, type Step } from "./routed-actions";
import {
	fillMessages,
	fillSchema,
	type ChoiceCandidate,
} from "./routed-choice";
import { styleOf } from "./routed-search";
import type { Turn } from "./routed-turn";
import { getLogger } from "../../../infrastructure/logger";
import { REPAIR_TOOLCHAIN } from "./diagnostic-evidence";

const log = getLogger("dialogue");

export type Filled = { fields: Record<string, unknown> } | { step: Step };

/** Fill arguments for a particular candidate; a question keeps the request the conversation wrote. */
export function fieldsOf(
	turn: Turn,
	text: string,
	candidate: ChoiceCandidate,
	asked?: string,
	diagnosticProvided = false,
): Promise<Filled> {
	const inputs = candidate.inputs as { properties?: object } | undefined;
	if (
		!(
			candidate.id === REPAIR_TOOLCHAIN &&
			!diagnosticProvided &&
			turn.routed?.diagnosticRefs?.length
		) &&
		!inputs?.properties &&
		!candidate.targets?.length
	)
		return Promise.resolve({ fields: {} });
	return fill(turn, text, candidate, asked);
}

/** The conversation model fills the one candidate's fields (it may also find nothing to ask for, or ask back). */
async function fill(
	turn: Turn,
	text: string,
	candidate: ChoiceCandidate,
	asked?: string,
): Promise<Filled> {
	const routed = turn.routed!;
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
			step: askBack(
				turn,
				typeof chosen.say === "string" ? chosen.say : "",
				asked,
			),
		};
	if (chosen.choice !== candidate.id) return { step: "talk" };
	return { fields: chosen };
}
