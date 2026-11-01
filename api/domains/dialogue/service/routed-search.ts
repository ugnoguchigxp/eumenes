import type { ToolchainCard } from "../../capabilities";
import type { QueryVector } from "../contracts/toolchains";
import { personaStyle } from "./context-system";
import { candidateOf } from "./executor-context";
import { TOOL_NAMES } from "./generation-tools";
import type { ChoiceCandidate } from "./routed-choice";
import type { Turn } from "./routed-turn";
import { sessionTargetsInTransaction } from "./specialist-context";

/** The longest query the toolchain search takes (`find_toolchain`'s bound). */
export const SEARCH_QUERY_CHARS = 2000;

/** What a turn's search offers: each candidate as the choice shows it, the cards behind them, and the query's vector. */
export type Searched = {
	candidates: ChoiceCandidate[];
	cards: ToolchainCard[];
	query?: QueryVector;
};

/**
 * The host searches with the user's words (the head of long ones: the search's query has a bound), and the toolchains
 * of the work in progress stay candidates though this search did not find them. `slots: "router"` searches the
 * router's wider slots; `record: false` is a look the turn keeps no trace of (the shadow router's).
 */
export async function searchTurn(
	turn: Turn,
	words: string,
	options: { slots?: "router"; record?: boolean } = {},
): Promise<Searched> {
	const { input } = turn;
	const args = {
		query: words.trim().slice(0, SEARCH_QUERY_CHARS),
		...(options.slots ? { slots: options.slots } : {}),
	};
	const found =
		options.record === false
			? await turn.probe(TOOL_NAMES.search, args)
			: await turn.act(TOOL_NAMES.search, args);
	const outcome = found && "outcome" in found ? found.outcome : null;
	const shown =
		(outcome?.result as { candidates?: ChoiceCandidate[] } | undefined)
			?.candidates ?? [];
	const kept = input.retained.filter(
		(entry) => !shown.some((c) => c.id === entry.card.id),
	);
	return {
		candidates: [
			...shown,
			...kept.map((entry) => retainedChoice(turn, entry.card)),
		],
		cards: [
			...(outcome?.search?.cards ?? []),
			...kept.map((entry) => entry.card),
		],
		...(outcome?.search?.query ? { query: outcome.search.query } : {}),
	};
}

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

/** A toolchain of the work in progress as a candidate: what its session works on stays its target (a change of it is confirmed). */
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
	const id = turn.routed?.switching;
	const card = id
		? turn.input.retained.find((entry) => entry.card.id === id)?.card
		: undefined;
	return card ? { id: card.id, title: card.title, card } : null;
}
