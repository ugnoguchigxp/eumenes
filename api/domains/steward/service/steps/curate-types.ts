import { stateKinds as stateKindsOf } from "../../../memory/contracts";
import { REQUESTS_PER_UNIT, type RequestKind } from "../../contracts";
import {
	type LabelTable,
	type MemoryRef,
	elements,
	isRecord,
	labels,
	oneOf,
	optionalText,
	text,
} from "../context";

const RESOLVE_ACTIONS = [
	"forget",
	"stop",
	"remember",
	"update",
	"withdraw",
	"none",
] as const;
/** The steward's own forget candidates per request (its prompt, not the conversation window). */
export const CANDIDATES_PER_REQUEST = 3;
export const CANDIDATES_TOTAL = 6;
export const CANDIDATE_CHARS = 500;
export const FORGET_SEARCHES = 3;

export type Resolve = {
	request: string;
	action: (typeof RESOLVE_ACTIONS)[number];
	refs: string[];
	alsoIn: string[];
	text: string | null;
	kind: (typeof stateKindsOf)[number] | null;
	key: string | null;
	negated?: boolean;
};
export type CurateOutput = {
	resolve: Resolve[];
	/** Elements the host dropped (unreadable or over a limit). */
	dropped: number;
};

export type RequestEntry = {
	id: string;
	what: string;
	detail: string | null;
	kind: RequestKind;
	messageId: string;
	/** The label of the event that shows the message the request was made in ("" when it is not shown). */
	event: string;
};
export type CurateContext = {
	events: LabelTable;
	requests: Record<string, RequestEntry>;
	refs: Record<string, MemoryRef>;
	/**
	 * What the model was shown of each ref (a memory item's text, a World entity's name and aliases, a claim's text, a
	 * goal's text), for the relevance check of a forget: a ref it does not share content with the request is not forgotten.
	 */
	shown: Record<string, string[]>;
	/** A claim ref -> the World entities it is about: the forget of an entity already removes the claim. */
	claimEntities: Record<string, string[]>;
	/** The text of each event of the unit, by label. */
	eventTexts: Record<string, string>;
};
export type Candidates = Record<string, string[]>;
export type CurateExtras = {
	candidates: Candidates;
	/** The user's text of each candidate (`c1`...), for the relevance check of a forget. */
	candidateTexts: Record<string, string>;
};

export function parseCurate(raw: unknown): CurateOutput | null {
	if (!isRecord(raw)) return null;
	let dropped = 0;
	const take = <T>(r: { items: T[]; dropped: number }) => {
		dropped += r.dropped;
		return r.items;
	};
	const resolve = take(
		elements<Resolve>(
			raw.resolve,
			(e) => {
				const request = text(e.request, 16);
				const action = oneOf(e.action, RESOLVE_ACTIONS);
				if (!request || !action) return null;
				return {
					request,
					action,
					refs: labels(e.refs),
					alsoIn: labels(e.alsoIn),
					text: optionalText(e.text, 500),
					kind: oneOf(e.kind, stateKindsOf),
					key: optionalText(e.key, 200),
					...(typeof e.negated === "boolean" ? { negated: e.negated } : {}),
				};
			},
			REQUESTS_PER_UNIT,
		),
	);
	return { resolve, dropped };
}
