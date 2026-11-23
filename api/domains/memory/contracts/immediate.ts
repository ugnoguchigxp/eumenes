import type { stateKinds } from "./state-kinds";

/**
 * Why an immediate operation did not change anything. An operation never throws for these: the caller's writer
 * transaction goes on (the model is told, and may repair its arguments in the same reply).
 */
export type ImmediateRejection =
	/** Memory is off or its journals are inconsistent. */
	| "memory_unavailable"
	| "invalid_input"
	| "invalid_key"
	| "invalid_validity"
	/** The evidence message is unknown, not the user's, or of another conversation. */
	| "invalid_source"
	| "blocked_source"
	| "source_tombstoned"
	/** The quote is not a substring of the message (only spaces, punctuation and width forms are forgiven). */
	| "quote_mismatch"
	| "limit_reached"
	/** The short reference was never handed out in the conversation's current window (or the window changed). */
	| "unknown_ref"
	/** The target is gone (forgotten) or was never there. */
	| "target_missing"
	/** The target is not at the version the model saw (or is no longer current). */
	| "target_changed"
	/** The target is excluded: a forget is on its way. */
	| "target_excluded"
	/** The fact the new record would join is excluded: a forget is on its way. */
	| "forget_pending"
	/** A forget is never withdrawn. */
	| "forget_not_withdrawable"
	| "nothing_to_withdraw"
	/** The earlier version a withdrawn correction brings back has no usable evidence any more. */
	| "cannot_restore"
	/** A tendency stands on fewer than two conversations. */
	| "not_enough_conversations"
	| "conflict";

export type Rejected = {
	status: "rejected";
	reason: ImmediateRejection;
	/** `conflict` of a statement the background pass noted: the record that stands (it is not replaced). */
	existingId?: string;
};

/** What a request names: the short reference of the conversation's window, or an item (with the version the caller saw). */
export type ItemTarget =
	{ ref: string } | { itemId: string; revision?: number };

export type StateKindName = (typeof stateKinds)[number];

/** The words of a new version, as the model gives them. */
type RecordFields = {
	text: string;
	polarity: "affirmed" | "negated";
	/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
	validFrom?: string | null;
	validUntil?: string | null;
};

/** What every write of the layer carries: where it was said, and the run that makes it (its own changes do not expire it). */
type Origin = {
	conversationId: string;
	sourceRunId: string;
};

/** The user's message the record stands on, and the words of it (a part of the message). */
type Grounding = {
	messageId: string;
	quote: string;
};

export type RememberExplicitInput = Origin &
	Grounding &
	RecordFields & {
		kind: StateKindName;
		semanticKey: string;
		subject: "self";
		/** false: the user said it of their own accord (not "remember this"): captured as the agent's, not a request. Default true. */
		requested?: boolean;
		/** Health, religion, belief, sexual orientation, political stance: kept out of the always-on section. */
		sensitive?: boolean;
		/** The record is about someone or something other than the user. */
		aboutOther?: boolean;
	};
export type RememberExplicitOutcome =
	| {
			status: "applied";
			/** The request a withdrawal names; null when an earlier inference was only confirmed in place (nothing to undo). */
			requestId: string | null;
			itemId: string;
			revision: number;
			/** The version this one replaced (a different value of the same fact was stored). */
			replacedItemId: string | null;
	  }
	| { status: "unchanged"; itemId: string; revision: number }
	| Rejected;

export type CorrectExplicitInput = Origin &
	Grounding &
	RecordFields & {
		target: ItemTarget;
		requested?: boolean;
	};
export type CorrectExplicitOutcome =
	| {
			status: "applied";
			requestId: string;
			itemId: string;
			revision: number;
			replacedItemId: string;
	  }
	| { status: "unchanged"; itemId: string; revision: number }
	| Rejected;

/** What a forget excludes: the items (every version of their facts), or a candidate. */
export type ExclusionTarget = ItemTarget | { candidateId: string };
export type ExcludeForForgetInput = Origin & {
	targets: readonly ExclusionTarget[];
};
export type ExcludeForForgetOutcome =
	| {
			status: "applied";
			/** Every State item that is excluded now (all versions of each fact, and the merge lineage). */
			itemIds: string[];
			candidateIds: string[];
			/** The messages the versions stand on: the caller hides them from the history until the closure delete. */
			evidenceMessageIds: string[];
			/** Journal lines written (0: everything was excluded already). */
			journaled: number;
	  }
	| Rejected;

/** What a suppression marks: a record (its whole fact), or a topic word when no record stands for the topic. */
export type SuppressionTarget = ItemTarget | { term: string };
export type SuppressInput = Origin & { target: SuppressionTarget };
export type SuppressOutcome =
	| {
			status: "applied" | "unchanged";
			scope: "fact" | "term";
			/** The marked item (scope fact), or the normalized word (scope term). */
			itemId: string | null;
			term: string | null;
	  }
	| Rejected;

/** Which applied request a withdrawal undoes; with none, the conversation's latest one still applied. */
export type WithdrawTarget =
	{ requestId: string } | { ref: string } | { itemId: string };
export type WithdrawExplicitInput = Origin & {
	target?: WithdrawTarget;
	/** The caller found the request to be a forget: refused at once. */
	ofForget?: boolean;
};
export type WithdrawExplicitOutcome =
	| {
			status: "applied";
			requestId: string;
			/** The version of the request, retracted. */
			retractedItemId: string;
			/** A correction: the earlier version brought back as a new version (null when it was forgotten meanwhile). */
			restoredItemId: string | null;
	  }
	| Rejected;

/** A reference handed out in the conversation's current window. */
export type ShortRef = { ref: string; itemId: string; revision: number };
