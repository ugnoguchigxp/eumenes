import type { ToolchainCard } from "../../capabilities";
import { personaStyle } from "./context-system";
import { candidateOf } from "./executor-context";
import type { ChoiceCandidate } from "./routed-choice";
import type { Turn } from "./routed-turn";
import { sessionTargetsInTransaction } from "./specialist-context";

/** The persona's style the choice calls write in. */
export function styleOf(turn: Turn): string {
	const { deps } = turn;
	return deps.store.read((tx) =>
		personaStyle(
			deps.larm.snapshotInTransaction?.(tx).general ?? {
				agentName: "",
				userName: "",
				persona: "butler",
			},
		),
	);
}

/** A toolchain already offered as a candidate: what its session works on stays its target. */
export function retainedChoice(
	turn: Turn,
	card: ToolchainCard,
): ChoiceCandidate {
	const { deps, input } = turn;
	return candidateOf(
		card,
		deps.store.read((tx) =>
			sessionTargetsInTransaction(deps, tx, card, input.runId),
		),
	);
}

/** The toolchain a hand-over waits for the user's word on (unsaved work stands in its way), when there is one. */
export function switchingOf(
	turn: Turn,
): { id: string; title: string; card: ToolchainCard } | null {
	const card = turn.input.switching;
	return card && card.id === turn.routed?.switching
		? { id: card.id, title: card.title, card }
		: null;
}
