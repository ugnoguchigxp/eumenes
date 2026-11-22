/**
 * L3 (plans with a date) and the question ledger: what replaces the short-term notes
 * (memory architecture redesign, sections 4.1 and 5.3). Both rest on evidence (the words of the user, or a
 * memory item) and are deleted with it when that is forgotten.
 */
export const planKinds = [
	"plan",
	"intent",
	"open_question",
	"decision",
] as const;
export type PlanKind = (typeof planKinds)[number];
export const planStates = ["open", "awaiting_confirmation", "closed"] as const;
export type PlanState = (typeof planStates)[number];
/** Same wording as the agency package's `questionStates`. */
export const questionStates = [
	"asked",
	"answered",
	"declined",
	"deferred",
] as const;
export type QuestionState = (typeof questionStates)[number];

/** Open plans (open or awaiting confirmation) of one conversation. */
export const MAX_OPEN_PLANS_PER_CONVERSATION = 30;
/** Open plans over all conversations. */
export const MAX_OPEN_PLANS = 200;
/** Entries of the question ledger over all conversations. */
export const MAX_QUESTIONS = 200;
export const PLAN_TEXT_MAX = 500;
export const QUOTE_MAX = 200;
export const ATTRIBUTE_MAX = 100;
/** Closed plans are kept this long (the reference of a late close or update still resolves), then pruned. */
export const CLOSED_PLAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The words the entry rests on. `quote` is a part of the message (null when the writer gave none). */
export interface PlanEvidence {
	conversationId: string;
	messageId: string;
	quote: string | null;
}
export interface PlanItem {
	id: string;
	/** The conversation the plan was first said in. */
	conversationId: string;
	kind: PlanKind;
	text: string;
	/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS][Z|+hh:mm]`; null when no date was named. */
	dueAt: string | null;
	state: PlanState;
	revision: number;
	createdAt: string;
	lastTouchedAt: string;
	evidence: PlanEvidence[];
	/** Memory items the plan was derived from (forgetting one deletes the plan). */
	memoryItemIds: string[];
}
export interface QuestionEntry {
	id: string;
	conversationId: string;
	attribute: string;
	state: QuestionState;
	revision: number;
	/** When the agent last asked (null when it never asked: the user brought it up). */
	askedAt: string | null;
	createdAt: string;
	updatedAt: string;
	evidence: PlanEvidence[];
	memoryItemIds: string[];
}

/** What every write must bring: at least one message of the user (or the agent's own question for `asked`). */
export interface EvidenceInput {
	/** Defaults to the entry's conversation. */
	messages: readonly {
		messageId: string;
		conversationId?: string;
		quote?: string | null;
	}[];
	memoryItemIds?: readonly string[];
}

/**
 * Which of the given sources are excluded right now (an immediate exclusion of forgetting that
 * has not finished its closure delete). Supplied by the memory domain; entries resting on an excluded
 * source are left out of every read.
 */
export type EvidenceExclusion = (
	db: import("bun:sqlite").Database,
	sources: {
		messageIds: readonly string[];
		memoryItemIds: readonly string[];
	},
) => {
	messageIds: ReadonlySet<string>;
	memoryItemIds: ReadonlySet<string>;
};
