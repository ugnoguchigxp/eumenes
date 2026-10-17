import { stateKinds as stateKindsOf } from "../../../memory/contracts";
import {
	EXCHANGES_PER_UNIT,
	REQUESTS_PER_UNIT,
	type RequestKind,
} from "../../contracts";
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
import type { StepEnv } from "../types";

const NOTE_KINDS = [
	"goal",
	"decision",
	"open_question",
	"activity",
	"memo",
] as const;
const STOP_WHY = ["contradicted", "outdated", "wrong", "user_asked"] as const;
const RESOLVE_ACTIONS = [
	"forget",
	"stop",
	"remember",
	"update",
	"none",
] as const;
/** The steward's own forget candidates per request (its prompt, not the conversation window). */
export const CANDIDATES_PER_REQUEST = 3;
export const CANDIDATES_TOTAL = 6;
export const CANDIDATE_CHARS = 500;
export const FORGET_SEARCHES = 3;

type Remember = {
	kind: (typeof stateKindsOf)[number];
	key: string;
	text: string;
	evidence: string;
	quote: string | null;
	validFrom: string | null;
	validUntil: string | null;
	negated: boolean;
};
type Update = {
	ref: string;
	text: string;
	evidence: string;
	quote: string | null;
	negated?: boolean;
};
type Stop = { ref: string; why: (typeof STOP_WHY)[number] };
type Note = {
	op: "add" | "update" | "close";
	ref: string | null;
	kind: (typeof NOTE_KINDS)[number] | null;
	text: string | null;
	status: "resolved" | "retracted" | null;
};
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
/** The judgment of one exchange: does it need a World step, does it need a goal step (section 3.4 of the World plan). */
export type Route = { exchange: string; world: boolean; goals: boolean };
export type CurateOutput = {
	remember: Remember[];
	update: Update[];
	stop: Stop[];
	notes: Note[];
	resolve: Resolve[];
	route: Route[];
	/** Elements the host dropped (unreadable or over a limit). */
	dropped: number;
};

export type RequestEntry = {
	id: string;
	what: string;
	detail: string | null;
	kind: RequestKind;
	messageId: string;
	/** The label of the exchange the request was made in. */
	exchange: string;
};
export type CurateContext = {
	exchanges: LabelTable;
	/** The exchanges this unit marks (input message ids). */
	targetIds: string[];
	requests: Record<string, RequestEntry>;
	refs: Record<string, MemoryRef>;
	/**
	 * What the model was shown of each ref (a memory item's text, a World entity's name and aliases, a claim's text, a
	 * goal's text), for the relevance check of a forget: a ref it does not share content with the request is not forgotten.
	 */
	shown: Record<string, string[]>;
	/** A claim ref -> the World entities it is about: the forget of an entity already removes the claim. */
	claimEntities: Record<string, string[]>;
	/** The user's text of each exchange of the unit, by label. */
	exchangeTexts: Record<string, string>;
	/** The version of each target exchange's messages the model read (a route is bound to it). */
	sources: Record<string, { revision: string; digest: string }>;
	digests: Record<string, string>;
	turns: Array<{ messageId: string; text: string }>;
	/** The live short-term notes' texts: an added note that repeats one is not saved twice. */
	noteTexts: string[];
};
export type Candidates = Record<string, string[]>;
export type TurnVectors = Awaited<
	ReturnType<StepEnv["deps"]["memory"]["vectors"]["embedTurns"]>
>;
export type CurateExtras = {
	turnVectors: Promise<TurnVectors> | TurnVectors;
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
	const remember = take(
		elements<Remember>(
			raw.remember,
			(e) => {
				const kind = oneOf(e.kind, stateKindsOf);
				const key = text(e.key, 200);
				const body = text(e.text, 500);
				const evidence = text(e.evidence, 16);
				if (!kind || !key || !body || !evidence) return null;
				return {
					kind,
					key,
					text: body,
					evidence,
					quote: optionalText(e.quote, 1024),
					validFrom: optionalText(e.validFrom, 10),
					validUntil: optionalText(e.validUntil, 10),
					negated: e.negated === true,
				};
			},
			6,
		),
	);
	const update = take(
		elements<Update>(
			raw.update,
			(e) => {
				const ref = text(e.ref, 16);
				const body = text(e.text, 500);
				const evidence = text(e.evidence, 16);
				if (!ref || !body || !evidence) return null;
				return {
					ref,
					text: body,
					evidence,
					quote: optionalText(e.quote, 1024),
					...(typeof e.negated === "boolean" ? { negated: e.negated } : {}),
				};
			},
			6 - remember.length,
		),
	);
	const stop = take(
		elements<Stop>(
			raw.stop,
			(e) => {
				const ref = text(e.ref, 16);
				const why = oneOf(e.why, STOP_WHY);
				return ref && why ? { ref, why } : null;
			},
			4,
		),
	);
	const notes = take(
		elements<Note>(
			raw.notes,
			(e) => {
				const op = oneOf(e.op, ["add", "update", "close"] as const);
				if (!op) return null;
				const ref = optionalText(e.ref, 16);
				const body = optionalText(e.text, 500);
				const status = oneOf(e.status, ["resolved", "retracted"] as const);
				if (op === "add" && !body) return null;
				if (op === "update" && (!ref || !body)) return null;
				if (op === "close" && (!ref || !status)) return null;
				return { op, ref, kind: oneOf(e.kind, NOTE_KINDS), text: body, status };
			},
			6,
		),
	);
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
	// A judgment the host can not read is "needed": nothing is skipped on a guess (an exchange without one counts as needed too).
	const route = take(
		elements<Route>(
			raw.route,
			(e) => {
				const exchange = text(e.exchange, 16);
				return exchange
					? { exchange, world: e.world !== false, goals: e.goals !== false }
					: null;
			},
			EXCHANGES_PER_UNIT,
		),
	);
	return { remember, update, stop, notes, resolve, route, dropped };
}
