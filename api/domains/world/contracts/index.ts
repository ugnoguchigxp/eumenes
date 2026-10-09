import type { Database } from "bun:sqlite";
import type { AccessContext, SourceRef } from "eumenes-memory";

/**
 * Identity of one World input source. `representation` is required here (a
 * SourceRef may omit it): the adapter never guesses a representation.
 */
export type SourceKey = {
	namespace: string;
	kind: string;
	id: string;
	representation: string;
};
export type SourceSpeaker = "user" | "assistant";

/** Current state of a source. Out-of-scope sources look exactly like `not_found`. */
export type SourceCurrent =
	| {
			status: "available";
			source: SourceKey;
			revision: string;
			digest: string;
			principal: string;
			scopeKey: string;
			speaker: SourceSpeaker;
			/** Only confirmed text is a World input; drafts/partial ASR never get here. */
			confirmed: true;
			/** Acceptance-order ordinal, comparable inside one scope. */
			ordinal: number;
	  }
	| {
			status: "missing";
			source: SourceKey;
			reason: "not_found" | "retracted";
	  };

export const SOURCE_RANGE_REASON_CODES = [
	"SOURCE_RANGE_OUT_OF_BOUNDS",
	"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
	"RANGE_TOO_LARGE",
] as const;
export type SourceRangeReasonCode = (typeof SOURCE_RANGE_REASON_CODES)[number];

/** Result of an authorized read. A body appears only on `ok`. */
export type SourceContent =
	| {
			status: "ok";
			source: SourceKey;
			revision: string;
			digest: string;
			/** The whole text, or the quoted slice when the ref carries a range. */
			text: string;
			/** SHA-256 hex of the quoted bytes; present only for range reads. */
			quoteDigest?: string;
	  }
	| { status: "missing"; source: SourceKey; reason: "not_found" | "retracted" }
	/** The ref's revision/digest is stale. Only the current revision is told. */
	| { status: "changed"; source: SourceKey; currentRevision: string }
	| {
			status: "invalid_range";
			source: SourceKey;
			reasonCode: SourceRangeReasonCode;
	  };

export type SourceChangeKind = "added" | "corrected" | "retracted";
/** One ordinary-change notification. No body; a retraction has an empty digest. */
export type SourceChange = {
	/** Opaque position token; pass the page's `nextCursor` back to continue. */
	cursor: string;
	kind: SourceChangeKind;
	source: SourceKey;
	revision: string;
	digest: string;
	principal: string;
	scopeKey: string;
	speaker: SourceSpeaker;
	occurredAt: string;
};
export type SourceChangePage = {
	changes: SourceChange[];
	/** Continue from here. Equals the request cursor when nothing was returned. */
	nextCursor: string;
	hasMore: boolean;
};
export type ListChangesRequest = {
	/** null starts from the beginning. Positions may have gaps. */
	cursor: string | null;
	limit: number;
};

/**
 * Host-side adapter that tells World what a source currently is. All methods run
 * synchronously on a connection borrowed from the host (writer callback or a
 * readonly snapshot); none opens a transaction.
 */
export interface SourceAdapter {
	readonly namespace: string;
	resolveCurrent(
		db: Database,
		access: AccessContext,
		key: SourceKey,
	): SourceCurrent;
	readAuthorizedContent(
		db: Database,
		access: AccessContext,
		ref: SourceRef,
	): SourceContent;
	listChanges(
		db: Database,
		access: AccessContext,
		request: ListChangesRequest,
	): SourceChangePage;
}
export {
	WORLD_FEEDS,
	WORLD_HOST_REASON_CODES,
	WORLD_PROVIDER_REF,
} from "./host";
export type {
	MemoryRegistrationSummary,
	ResolvedInput,
	WorldApplyRequest,
	WorldApplyResult,
	WorldFeed,
	WorldHistoryReadResult,
	WorldHistoryRequest,
	WorldHostReasonCode,
	WorldReadRequest,
	WorldReadResult,
	WorldRequestAccess,
	WorldSchemaStatus,
	WorldStatus,
	WorldUsageCheck,
} from "./host";
export { WORLD_RUNTIME_PURPOSE } from "./runtime";
export type {
	RuntimeLedgerPort,
	RuntimeMeasurement,
	RuntimeSnapshot,
	RuntimeVerification,
} from "./runtime";
export {
	WORLD_QUERY_LIMITS,
	WORLD_QUERY_MODES,
	WORLD_QUERY_REJECTIONS,
	worldQuerySchema,
	worldQueryToolSchema,
} from "./query";
export type {
	GapTaskDecision,
	GapTaskLink,
	GapTaskLinkage,
	GapTaskLinkStatus,
	GapTaskPort,
	GapTaskRequest,
	ResourceStatePort,
	WorldQueryBasis,
	WorldQueryBudget,
	WorldQueryContext,
	WorldQueryMode,
	WorldQueryPayload,
	WorldQueryRejection,
	WorldQueryRequest,
	WorldQueryResult,
} from "./query";
export * from "./claims";
