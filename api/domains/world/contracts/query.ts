import type { Database } from "bun:sqlite";
import { z } from "zod";
import type {
	CompareResult,
	DependencyResult,
	GapResult,
	InfluenceResult,
	RelevanceResult,
	ResearchGap,
	ResourceState,
} from "eumenes-world-model";

/**
 * `world.query` (P5-01): the one product entry for World's pure reasoning.
 * Everything here is an ENUMERATED, bounded read. There is no free-form SQL, no
 * graph mutation, and no way to name a principal.
 */
export const WORLD_QUERY_MODES = [
	"snapshot",
	"relevance",
	"influence",
	"dependencies",
	"scenarios",
	"gaps",
] as const;
export type WorldQueryMode = (typeof WORLD_QUERY_MODES)[number];

/** Upper bounds. A request above any of them is rejected, never clamped. */
export const WORLD_QUERY_LIMITS = {
	/** Serialized request, UTF-8 bytes. */
	requestBytes: 64 * 1024,
	/** Opaque ids (scope key, goal, entity, overlay): UTF-8 bytes. */
	idBytes: 256,
	/** Start entities of a focused snapshot / gap search. */
	startPoints: 10,
	/** Hops the snapshot retrieval walks from the start entities. */
	focusDepth: 4,
	/** Hypothetical edges per scenario overlay (same as the pure API). */
	overlayEdges: 100,
	/** Overlay edges removed per scenario. */
	overlayRemovals: 100,
	/** Retrieval and traversal budgets: the C5 defaults. */
	budget: {
		causalDepth: 3,
		relevanceDepth: 4,
		entities: 30,
		relations: 60,
		paths: 10,
		candidates: 500,
		expansions: 500,
		presentationBytes: 8192,
	},
	/** Snapshot-mode entries, whole entries dropped past it. */
	snapshotBytes: 8 * 1024,
	/** Evidence/condition material attached to a reasoning result. */
	basisBytes: 12 * 1024,
	/** Gaps handed to the Task port in one call, in the pure API's order. */
	gapLinks: 5,
} as const;

const utf8 = (value: string) => new TextEncoder().encode(value).length;
const id = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		// Reported as `too_big` so an oversized id is a limit, not a typo.
		if (utf8(value) > WORLD_QUERY_LIMITS.idBytes)
			ctx.addIssue({
				code: "too_big",
				origin: "string",
				maximum: WORLD_QUERY_LIMITS.idBytes,
				inclusive: true,
				input: value,
			});
	});

const bound = (max: number) => z.number().int().min(1).max(max);
const budgetSchema = z.strictObject({
	causalDepth: bound(WORLD_QUERY_LIMITS.budget.causalDepth).optional(),
	relevanceDepth: bound(WORLD_QUERY_LIMITS.budget.relevanceDepth).optional(),
	entities: bound(WORLD_QUERY_LIMITS.budget.entities).optional(),
	relations: bound(WORLD_QUERY_LIMITS.budget.relations).optional(),
	paths: bound(WORLD_QUERY_LIMITS.budget.paths).optional(),
	// World's bounded read needs at least the row and its sentinel.
	candidates: z
		.number()
		.int()
		.min(2)
		.max(WORLD_QUERY_LIMITS.budget.candidates)
		.optional(),
	expansions: z
		.number()
		.int()
		.min(2)
		.max(WORLD_QUERY_LIMITS.budget.expansions)
		.optional(),
	presentationBytes: bound(
		WORLD_QUERY_LIMITS.budget.presentationBytes,
	).optional(),
});
export type WorldQueryBudget = z.infer<typeof budgetSchema>;

const common = {
	/** Defaults to the only scope the host allows. A scope the host did not grant is `not_available`. */
	scopeKey: id.optional(),
	budget: budgetSchema.optional(),
};
const direction = z.enum(["forward", "reverse"]);
const overlay = z.strictObject({
	overlayId: id,
	addEdges: z.array(z.unknown()).max(WORLD_QUERY_LIMITS.overlayEdges),
	removeEdgeIds: z.array(id).max(WORLD_QUERY_LIMITS.overlayRemovals),
});
const startPoints = z
	.array(id)
	.min(1)
	.max(WORLD_QUERY_LIMITS.startPoints)
	.refine((ids) => new Set(ids).size === ids.length);

const gapsSchema = z.strictObject({
	mode: z.literal("gaps"),
	...common,
	entityIds: startPoints.optional(),
	/** An ADOPTED Goal of the scope, or a withdrawn one (which blocks nothing). */
	goalId: id.optional(),
});
const worldQueryModes = [
	z.strictObject({
		mode: z.literal("snapshot"),
		...common,
		entityIds: startPoints.optional(),
		depth: z
			.number()
			.int()
			.min(0)
			.max(WORLD_QUERY_LIMITS.focusDepth)
			.optional(),
	}),
	z.strictObject({
		mode: z.literal("relevance"),
		...common,
		entityId: id,
	}),
	z.strictObject({
		mode: z.literal("influence"),
		...common,
		entityId: id,
		direction: direction.optional(),
	}),
	z.strictObject({
		mode: z.literal("dependencies"),
		...common,
		entityId: id,
	}),
	z.strictObject({
		mode: z.literal("scenarios"),
		...common,
		entityId: id,
		direction: direction.optional(),
		overlays: z.tuple([overlay, overlay]),
	}),
] as const;

export const worldQuerySchema = z.discriminatedUnion("mode", [
	...worldQueryModes,
	gapsSchema.extend({
		/**
		 * Ask the host to open an investigation Task for the listed Gaps. It is a
		 * request, never a grant: the host's Task port decides (delegation and
		 * budget). Without a port, or without delegation, no Task is created.
		 */
		linkGaps: z.boolean().optional(),
	}),
]);
export type WorldQueryRequest = z.infer<typeof worldQuerySchema>;

/**
 * What a MODEL may call: the same modes, but Gap -> Task linkage is not part of
 * the model's vocabulary (`linkGaps` is an unknown key and is rejected).
 */
export const worldQueryToolSchema = z.discriminatedUnion("mode", [
	...worldQueryModes,
	gapsSchema,
]);

/** Who is asking. Built by trusted host code, never by a request body or a model. */
export type WorldQueryContext = {
	principal: string;
	/** The scopes this caller may read. Anything else is `not_available`. */
	scopeKeys: readonly string[];
	/** AccessContext purpose the source adapters must allow. */
	purpose?: string;
	/** Opaque host data (origin of the call) handed unchanged to the Task port. */
	origin?: unknown;
};

export const WORLD_QUERY_REJECTIONS = [
	"invalid_request",
	"unknown_mode",
	"limit_exceeded",
	/** Scope, Goal or start point the caller may not use; also a forgotten/blocked one. Never says which. */
	"not_available",
] as const;
export type WorldQueryRejection = (typeof WORLD_QUERY_REJECTIONS)[number];

/** The claim behind a result item: evidence, conditions and what disputes it. */
export type WorldQueryBasis = {
	id: string;
	revision: number;
	subjectId: string;
	predicate: string;
	relation?: { kind: string; objectId: string };
	value?: unknown;
	status: string;
	freshness: unknown;
	origin: string;
	causalEligible: boolean;
	condition: unknown;
	refutations: { id: string; revision: number }[];
	sources: {
		namespace: string;
		kind: string;
		id: string;
		revision: string;
	}[];
};

export type GapTaskLinkStatus =
	| "created"
	/** The same Gap already has its Task: nothing new was created. */
	| "linked"
	| "denied"
	/** Gaps past the per-call link limit. */
	| "skipped";
export type GapTaskLink = {
	gapKey: string;
	dedupeKey: string;
	status: GapTaskLinkStatus;
	reason?: string;
};
export type GapTaskLinkage =
	/** No Task port: Gaps are shown only. */
	{ status: "not_accepted" } | { status: "attempted"; links: GapTaskLink[] };

export type WorldQueryPayload =
	| { mode: "snapshot"; entries: WorldQueryBasis[] }
	| { mode: "relevance"; relevance: RelevanceResult }
	| { mode: "influence"; influence: InfluenceResult }
	| { mode: "dependencies"; dependencies: DependencyResult }
	/** Overlays are hypothetical copies: nothing is stored or adopted. */
	| { mode: "scenarios"; scenarios: CompareResult; hypothetical: true }
	| { mode: "gaps"; gaps: GapResult };

export type WorldQueryResult =
	| {
			status: "ok";
			mode: WorldQueryMode;
			scopeKey: string;
			asOf: number;
			/** partial: a budget stopped retrieval or traversal. Absence is NOT "no effect". */
			completeness: "complete" | "partial";
			reasons: string[];
			result: WorldQueryPayload;
			/** Evidence and conditions of the items in `result`. */
			basis: WorldQueryBasis[];
			basisTruncated: boolean;
			/** What the bounded read did; the counters never exceed the budget. */
			retrieval: {
				partial: boolean;
				reasons: string[];
				fetchedRows: number;
				expandedRows: number;
			};
			/** Claim text is reference data. It never carries instruction authority. */
			referenceOnly: true;
			/** A query grants nothing. Gaps are investigation candidates only. */
			executionPermission: "none";
			/** Gaps mode only. */
			taskLinkage?: GapTaskLinkage;
	  }
	| { status: "disabled"; code: "world_disabled" }
	| { status: "blocked"; code: "world_unavailable" }
	| { status: "rejected"; code: WorldQueryRejection };

/**
 * The host's side of Gap -> Task. World never creates a Task itself. The port
 * answers in the SAME writer transaction, after checking that the principal
 * delegated the work and that the budget has room.
 */
export type GapTaskRequest = {
	principal: string;
	scopeKey: string;
	/** Stable per (principal, scope, Gap): the same Gap is the same key forever. */
	dedupeKey: string;
	gap: ResearchGap;
	origin: unknown;
};
export type GapTaskDecision =
	| { status: "created"; taskRef: string }
	| { status: "denied"; reason: string };
export interface GapTaskPort {
	linkInTransaction(db: Database, request: GapTaskRequest): GapTaskDecision;
}

/** Resource availability is host knowledge (registry, ledger), never taken from a request. */
export type ResourceStatePort = (
	db: Database,
	scope: { principal: string; scopeKey: string },
) => readonly { entityId: string; state: ResourceState }[];
