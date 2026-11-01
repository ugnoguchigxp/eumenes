/**
 * The router of LARM's decision provider (spec toolchain-router-redesign 2026-11-01 §3.2, §3.4; the LARM request
 * prompt §2): one `system-one` choice over the criteria a turn offers (the conversation, the toolchains its search
 * found, the host's operations), and a second call that fills the chosen one's fields by choice and extraction. The
 * criteria change on every call; the model is whatever the saved router profile's claim names.
 */
export const ROUTE_LIMITS = {
	/** Criteria of one choice (the search keeps a turn's offer far below this). */
	criteria: 128,
	/** A criterion's name: ASCII, starting with a letter (object key order must stay the order sent). */
	name: 96,
	/** A criterion's description, in characters. */
	description: 300,
	/** The newest utterance: its head. */
	text: 2000,
	/** The agent's and the user's utterance before it: their tails. */
	previous: 1000,
} as const;
/** A criterion's name: a letter, then letters, digits and `.`, `:`, `_`, `-` (e.g. `t3.redirect:music.create`). */
export const routeCriterionName = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;
/** A question's name in the fields call: lower-case ASCII; `fields` is the extraction's own. */
export const routeQuestionName = /^[a-z][a-z0-9_]{0,31}$/;

export type RouteCriterion = { name: string; description: string };

/** What the router reads: the newest utterance, the two utterances before it, and the criteria in the order sent. */
export type RouteInput = {
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	instructions: string;
	criteria: readonly RouteCriterion[];
};

/** The router's answer as LARM gave it: scores of what was offered, never an instruction. */
export type RouteAnswer = {
	choice: string;
	/** Every criterion sent, summing to 1 (calibrated by LARM, per `calibrationRevision`). */
	probabilities: Record<string, number>;
	/** Independent 0..1 per criterion when the model gives them (a request of two toolchains shows here); else null. */
	scores: Record<string, number> | null;
	model: string;
	headRevision: string | null;
	calibrationRevision: string | null;
};

/** The extraction's schema: one flat object of strings, numbers, booleans and string enums. */
export type RouteFieldSchema = {
	type: "object";
	required: string[];
	properties: Record<
		string,
		{
			type: "string" | "number" | "boolean";
			enum?: string[];
			description?: string;
		}
	>;
};

/** The second call: the chosen candidate's enumerated fields as choices, its free fields as one extraction. */
export type RouteFieldsInput = {
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	choices: Record<
		string,
		{ instructions: string; criteria: readonly RouteCriterion[] }
	>;
	extract: { instructions: string; schema: RouteFieldSchema } | null;
};

export type RouteFieldsAnswer = {
	/** The criterion chosen for each choice question asked. */
	choices: Record<string, string>;
	/** The extracted values (null where the utterance does not say); null when no extraction was asked. */
	values: Record<string, string | number | boolean | null> | null;
	/** 0..1 per extracted field when LARM gives it; else null. */
	confidence: Record<string, number> | null;
	model: string;
	headRevision: string | null;
};

/** Codes the router's port throws; a caller falls back from each (none is shown to the user as is). */
export const routeErrors = {
	/** The input breaks the limits above: a caller bug. */
	invalidRequest: "larm_invalid_route_request",
	/** The answer misses a criterion, leaves the set, or has scores out of range. */
	invalidResponse: "larm_invalid_route_response",
	/** LARM dropped criteria or cut the state: no partial answer is used. */
	truncated: "larm_route_truncated",
	/** The deployed model cannot extract (HTTP 400 `unsupported_question_type`): the caller fills the fields itself. */
	extractUnsupported: "larm_route_extract_unsupported",
	/** A port that is not the router's (`decisionOnly`) was asked. */
	portRequired: "larm_route_port_required",
} as const;
