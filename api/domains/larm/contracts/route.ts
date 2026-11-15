/**
 * The reranker's contract (LARM's context judgment, used by best-v2): one answer
 * with an independent score per criterion the turn offers. Filling fields is the host's.
 */
export const ROUTE_LIMITS = {
	/** Criteria of one request (the offer keeps a turn far below this). */
	criteria: 128,
	/** A criterion's name: ASCII, starting with a letter. */
	name: 96,
	/** A criterion's description (a card's reranker document), in characters. */
	description: 4096,
	/** The newest utterance as embedded and searched: its head. */
	text: 2000,
	/** The newest utterance as the reranker reads it: its head. */
	rerankText: 400,
	/** The agent's and the user's utterance before it: their tails. */
	previous: 1000,
} as const;

/** A letter, then letters, digits and `.`, `:`, `_`, `-`. */
export const routeCriterionName = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;

export type RouteCriterion = { name: string; description: string };

/** What the reranker reads. The host supplies `instructions`; this package does not write them. */
export type RouteInput = {
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	instructions: string;
	criteria: readonly RouteCriterion[];
};

/** The scorer's answer: scores of what was offered, never an instruction. */
export type RouteAnswer = {
	choice: string;
	/** Every criterion sent, summing to 1. */
	probabilities: Record<string, number>;
	/** Independent 0..1 per criterion when the scorer gives them; else null. */
	scores: Record<string, number> | null;
	model: string;
	headRevision: string | null;
	calibrationRevision: string | null;
};

/** Codes the route throws. Copied from the product's choice contract. */
export const routeErrors = {
	invalidRequest: "larm_invalid_route_request",
	invalidResponse: "larm_invalid_route_response",
	truncated: "larm_route_truncated",
	extractUnsupported: "larm_route_extract_unsupported",
	portRequired: "larm_route_port_required",
} as const;
