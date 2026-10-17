import { z } from "zod";

/** Bounds are enforced by rejection; nothing is truncated. */
const MAX_DESIRED_STATE_LENGTH = 500;
const MAX_KEY_LENGTH = 256;
const MAX_SNAPSHOT_SCOPES = 32;
/** Adopted goals per (principal, scope): keeps the snapshot inside a fixed budget. */
export const MAX_ADOPTED_GOALS = 30;
/** Open proposals per (principal, scope). */
export const MAX_PROPOSED_GOALS = 50;
/** Conversation messages one goal revision may cite as its basis. */
const MAX_SOURCE_MESSAGES = 20;
/** World entities one goal change may link. */
const MAX_GOAL_ENTITIES = 20;
/** Operations one steward batch may carry. */
export const MAX_GOAL_OPS = 50;
/** Goals and entities one forget call may name. */
const MAX_FORGET_IDS = 500;
const MIN_PRIORITY = 0;
const MAX_PRIORITY = 100;
const DEFAULT_PRIORITY = 50;

export const goalStatuses = [
	"proposed",
	"adopted",
	"withdrawn",
	"completed",
] as const;
export type GoalStatus = (typeof goalStatuses)[number];

const key = z.string().min(1).max(MAX_KEY_LENGTH);

/**
 * Opaque reference to the utterance or operation behind a goal change.
 * Structurally compatible with the Memory SourceRef; goals never resolves it.
 */
const goalSourceSchema = z
	.object({
		namespace: key,
		kind: key,
		id: key,
		revision: key.optional(),
		digest: key.optional(),
		representation: key.optional(),
	})
	.strict();
export type GoalSource = z.infer<typeof goalSourceSchema>;

/** The slice of the host AccessContext that goals needs; extra fields are fine. */
export interface GoalAccess {
	principal: string;
	scopeKeys: readonly string[];
}
export const goalAccessSchema = z.object({
	principal: key,
	scopeKeys: z.array(key).min(1).max(MAX_SNAPSHOT_SCOPES),
});

/**
 * Provenance of a goal revision for forgetting (F8/F10): the conversation
 * messages the revision is based on, and the World entities the goal concerns.
 * Message ids are stored per revision. Entity ids accumulate: a goal stays
 * linked to every entity any of its revisions was linked to, so forgetting an
 * entity also reaches goals whose older revisions mentioned it.
 */
const sourceMessageIds = z.array(key).max(MAX_SOURCE_MESSAGES).default([]);
const entityIds = z.array(key).max(MAX_GOAL_ENTITIES).default([]);

const desiredState = z.string().trim().min(1).max(MAX_DESIRED_STATE_LENGTH);
const priority = z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY);
const expectedRevision = z.number().int().min(1);
/**
 * Caller-chosen idempotency key, unique per (principal, scope). Replaying the
 * same payload returns the same goal; a different payload is `operation_conflict`.
 */
const operationKey = key.optional();

/** Explicit adoption of a new goal by the host. */
export const adoptGoalSchema = z
	.object({
		scopeKey: key,
		desiredState,
		priority: priority.default(DEFAULT_PRIORITY),
		source: goalSourceSchema,
		sourceMessageIds,
		entityIds,
		operationKey,
	})
	.strict();
export type AdoptGoal = z.input<typeof adoptGoalSchema>;

/** Recording an inferred goal (same shape as an adoption); it never becomes visible as adopted. */
export type ProposeGoal = AdoptGoal;

/** Explicit adoption of an existing proposal. */
export const adoptProposalSchema = z
	.object({
		expectedRevision,
		/** Optional edits applied in the same revision as the adoption. */
		desiredState: desiredState.optional(),
		priority: priority.optional(),
		source: goalSourceSchema,
		sourceMessageIds,
		entityIds,
	})
	.strict();
export type AdoptProposal = z.input<typeof adoptProposalSchema>;

export const updateGoalSchema = z
	.object({
		expectedRevision,
		desiredState: desiredState.optional(),
		priority: priority.optional(),
		source: goalSourceSchema,
		sourceMessageIds,
		entityIds,
	})
	.strict()
	.refine((v) => v.desiredState !== undefined || v.priority !== undefined, {
		message: "goal_update_empty",
	});
export type UpdateGoal = z.input<typeof updateGoalSchema>;

/** Used for withdraw and complete. */
export const goalTransitionSchema = z
	.object({
		expectedRevision,
		source: goalSourceSchema,
		sourceMessageIds,
		entityIds,
	})
	.strict();
export type GoalTransition = z.input<typeof goalTransitionSchema>;

export const forgetGoalsSchema = z
	.object({
		goalIds: z.array(key).max(MAX_FORGET_IDS),
		entityIds: z.array(key).max(MAX_FORGET_IDS),
	})
	.strict();
export type ForgetGoalsInput = z.input<typeof forgetGoalsSchema>;

/** Goals that a forget deletes and every message any of their revisions cites. */
export interface ForgetGoalsResult {
	goalIds: string[];
	messageIds: string[];
}

/** Why one operation of a batch was not applied. Nothing of it was written. */
export const goalRejectReasons = [
	"invalid_goal_input",
	"source_required",
	"goal_scope_forbidden",
	"invalid_goal",
	"revision_conflict",
	"goal_state_conflict",
	"goal_limit",
	"operation_conflict",
] as const;
export type GoalRejectReason = (typeof goalRejectReasons)[number];

/**
 * One steward operation. Input types are the plain operations' plus the
 * discriminator; `sourceMessageIds` is required (at least one) in a batch.
 */
export type GoalOp =
	| ({ op: "propose" } & ProposeGoal)
	| ({ op: "adopt"; goalId?: undefined } & AdoptGoal)
	| ({ op: "adopt"; goalId: string } & AdoptProposal)
	| ({ op: "revise"; goalId: string } & UpdateGoal)
	| ({ op: "complete" | "withdraw"; goalId: string } & GoalTransition);

export type GoalOpResult =
	| {
			index: number;
			status: "applied";
			goal: Goal;
			/** The operationKey had already created this goal; nothing was written. */
			replayed: boolean;
	  }
	| { index: number; status: "rejected"; reason: GoalRejectReason };

/** A goal as the steward reviews it (every status). */
export interface StewardGoal {
	goalId: string;
	scopeKey: string;
	status: GoalStatus;
	priority: number;
	desiredState: string;
	revision: number;
	updatedAt: string;
}

/** An adopted goal as the context builder reads it. */
export interface ContextGoal {
	goalId: string;
	scopeKey: string;
	priority: number;
	desiredState: string;
	revision: number;
	updatedAt: string;
}

export interface Goal {
	id: string;
	principal: string;
	scopeKey: string;
	desiredState: string;
	priority: number;
	status: GoalStatus;
	/** Source of the latest explicit change (adopt/update/withdraw/complete). */
	source: GoalSource;
	/** Source that proposed the goal, when it started as a proposal. */
	proposedFrom: GoalSource | null;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

/** What other domains may carry about an adopted goal. */
export interface GoalRef {
	goalId: string;
	scopeKey: string;
	desiredState: string;
	priority: number;
	revision: number;
	source: GoalSource;
}

/**
 * One consistent read of the adopted goals visible to an access context.
 * `absent` means no adopted goal exists: callers must not invent one.
 */
export interface GoalSnapshot {
	principal: string;
	/** Sorted, de-duplicated scopes the snapshot covers. */
	scopeKeys: string[];
	state: "present" | "absent";
	/** Adopted goals only, by priority (high first) then adoption order. */
	goals: GoalRef[];
	/** Per-scope goal epoch; strictly increases on every visible change. */
	scopeEpochs: { scopeKey: string; epoch: number }[];
	/** Sum of the scope epochs: monotonic for a fixed scope set. */
	revision: number;
	/** sha256 of the canonical snapshot content (goals, revisions, epochs). */
	digest: string;
}

export interface GoalRevision {
	goalId: string;
	principal: string;
	scopeKey: string;
	status: GoalStatus;
	revision: number;
	/** Current goal epoch of the goal's scope. */
	scopeEpoch: number;
}
