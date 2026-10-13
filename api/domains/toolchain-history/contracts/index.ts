import { z } from "zod";

/** One toolchain the conversation model was offered, and why it ranked where it did. */
export type SelectionCandidate = {
	toolchainId: string;
	revisionId: string;
	functionName: string;
	rank: number;
	ftsRank: number | null;
	similarity: number | null;
	fromHistory: boolean;
};
/**
 * toolchain: the model called one offered toolchain. answer: it replied in text (an answer
 * or a clarifying question; the two are not told apart). rejected: its output broke the contract.
 */
export type SelectionDecision = "toolchain" | "answer" | "rejected";
export type SelectionOutcome =
	| "answered"
	| "partial"
	| "not_found"
	| "clarification_required"
	| "failed"
	| "cancelled"
	| "expired"
	| "completed";
export type Selection = {
	id: string;
	runId: string;
	conversationId: string;
	utteranceId: string | null;
	requestId: string | null;
	retrieval: "fts" | "embedding" | "hybrid" | "none";
	candidates: SelectionCandidate[];
	historyRefs: string[];
	decision: SelectionDecision;
	toolchainId: string | null;
	toolchainRevisionId: string | null;
	functionName: string | null;
	request: string | null;
	repaired: boolean;
	taskId: string | null;
	outcome: SelectionOutcome | null;
	outcomeCode: string | null;
	recipe: "matched" | "missed" | "saved" | null;
	durationMs: number | null;
	createdAt: number;
	settledAt: number | null;
};
/** A past selection offered to the conversation model as reference data only. */
export type PastSelection = {
	selectionId: string;
	request: string;
	functionName: string;
	outcome: SelectionOutcome | null;
};
export type RecipeState = "active" | "suspended" | "disabled";
export type Recipe = {
	id: string;
	toolchainId: string;
	signature: string;
	url: string;
	readHint: string;
	state: RecipeState;
	successes: number;
	failures: number;
	consecutiveFailures: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	createdAt: number;
	updatedAt: number;
};
/** A saved procedure proposed by a sub-agent's report; only structured, bounded fields. */
export const recipeProposal = z
	.object({
		signature: z.string().trim().min(1).max(200),
		url: z.url().max(2048),
		readHint: z.string().trim().min(1).max(200),
	})
	.strict();
export type RecipeProposal = z.infer<typeof recipeProposal>;
/** Consecutive failures that suspend a procedure; the next request starts from search. */
export const RECIPE_SUSPEND_AFTER = 3;
/** Selection traces are kept like other conversation metadata. */
export const SELECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export * from "./record-pages";
