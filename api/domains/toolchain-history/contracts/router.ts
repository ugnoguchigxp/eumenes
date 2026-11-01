import { z } from "zod";
import type { VectorSpaceShape } from "../../../infrastructure/vector";

/**
 * The router's records (spec toolchain-router-redesign 2026-11-01 §5.3, §6.2): a trace of each routed request turn
 * (what was offered, the probabilities, what was decided), and the corrections a user made, which bias the next
 * routing of a near utterance. Neither holds model output as an instruction; both hold the utterance the user said,
 * so a forget of that message removes them.
 */
export type RouterCandidateKind =
	| "conversation"
	| "toolchain"
	| "read"
	| "memory"
	| "work"
	| "redirect"
	| "pending";

/** What the router saw and decided in one request turn (no utterance text: that is the record's own column). */
export type RouterTrace = {
	mode: "shadow" | "on";
	revision: string | null;
	model: string | null;
	candidates: Array<{
		id: string;
		kind: RouterCandidateKind;
		/** LARM's probability. */
		raw: number;
		/** The correction added to its log-probability (0 without a near correction). */
		correction: number;
		/** The probability after the correction. */
		p: number;
		/** LARM's independent score, when it gives one. */
		score: number | null;
	}>;
	/** The prediction set, best first (at most 3): the alternatives a correction may move to. */
	set: string[];
	/** The decision table's row (§3.3); 0 when the router failed. */
	row: number;
	/** The candidate decided (`on`) or that would have been decided (`shadow`); null for none. */
	decided: string | null;
	durationMs: number;
	/** The failure code when the router failed (row 0). */
	error: string | null;
};

/** An utterance's vector in the toolchain search's space (the corrections are found by it). */
export type RouterQuery = { space: VectorSpaceShape; vector: number[] };

/** A stored trace with what a later turn needs of it: its utterance (and its vector) and the work it started. */
export type RouterTraceRecord = {
	runId: string;
	conversationId: string;
	messageId: string;
	/** Every message the text was made from (the joined turn, an asked request): a forget of any removes it. */
	messageIds: string[];
	text: string;
	query: RouterQuery | null;
	decided: string | null;
	workId: string | null;
	set: string[];
	/** The decision table's row (§3.3) and the mode the turn was routed in; 0 when the router failed. */
	row: number;
	mode: RouterTrace["mode"];
	createdAt: number;
};

export const routerFeedbackSources = [
	"redirect",
	"ask_answer",
	"ui_pick",
	"review",
] as const;
export type RouterFeedbackSource = (typeof routerFeedbackSources)[number];
export const routerFeedbackStates = [
	"active",
	"retracted",
	"stale",
	"conflict",
] as const;
export type RouterFeedbackState = (typeof routerFeedbackStates)[number];

/** A user's correction: for an utterance like this one, `right` and not `wrong`. */
export type RouterFeedback = {
	id: string;
	conversationId: string;
	messageId: string;
	runId: string;
	source: RouterFeedbackSource;
	text: string;
	wrongId: string | null;
	rightId: string;
	state: RouterFeedbackState;
	createdAt: number;
	updatedAt: number;
};

/** A correction near the utterance being routed, with how near (inner product in the search's vector space). */
export type NearFeedback = {
	id: string;
	wrongId: string | null;
	rightId: string;
	similarity: number;
};

/** The state change the review API accepts. */
export const routerFeedbackStateBody = z
	.object({ state: z.enum(routerFeedbackStates) })
	.strict();

/** The traces live as long as the selections; corrections stay until retracted or forgotten. */
export const ROUTER_TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
