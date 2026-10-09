import type { AccessContext, SourceRef } from "eumenes-memory";
import type { ScopeRef } from "eumenes-world-model";
import type {
	WorldHistoryResult,
	WorldOperation,
	WorldOperationResult,
	WorldSnapshotResult,
	WorldUsageResult,
} from "eumenes-world-model/sqlite";

/** Feeds whose cursors the host stores. A cursor is valid only for the restore epoch that issued it. */
export const WORLD_FEEDS = ["source", "memory"] as const;
export type WorldFeed = (typeof WORLD_FEEDS)[number];

/** Provider name Memory sees for every World-derived dependent. Fixed; never configurable. */
export const WORLD_PROVIDER_REF = "eumenes-world";

/** The caller names the purpose and scopes; the host adds the policy revision. */
export type WorldRequestAccess = Omit<AccessContext, "policyRevision">;

export type WorldApplyRequest = {
	access: WorldRequestAccess;
	scope: ScopeRef;
	operationKey: string;
	/** UTC epoch ms supplied by the caller (never read from a clock inside World). */
	clock: number;
	operation: WorldOperation;
};

export type WorldReadRequest = {
	access: WorldRequestAccess;
	scope: ScopeRef;
	asOf: number;
	focus?: { subjectIds: string[]; depth?: number };
	budget?: { candidates?: number; expansions?: number };
};

/** Host-side reasons. World's own reason codes pass through unchanged. */
export const WORLD_HOST_REASON_CODES = [
	"WORLD_DISABLED",
	"SOURCE_NOT_AVAILABLE",
	"SOURCE_REPRESENTATION_REQUIRED",
	"SOURCE_ADAPTER_MISSING",
	"DEPENDENCY_LIMIT",
	"MEMORY_TOMBSTONED",
	"MEMORY_DEPENDENCY_MISSING",
	"MEMORY_EXTERNAL_ID_IN_USE",
	"MEMORY_SCOPE_NOT_PERMITTED",
	"MEMORY_CONTRACT_REJECTED",
	"MEMORY_UNAVAILABLE",
	"WRITER_BUSY",
	"STORE_CLOSING",
	"WORLD_RECOVERY_REQUIRED",
] as const;
export type WorldHostReasonCode = (typeof WORLD_HOST_REASON_CODES)[number];

export type MemoryRegistrationSummary = {
	/** Memory dependents written for this operation (an input set above 32 is split). */
	dependents: number;
	registered: number;
	unchanged: number;
};

export type WorldApplyResult =
	| (Extract<WorldOperationResult, { status: "applied" | "no_op" }> & {
			memory?: MemoryRegistrationSummary;
	  })
	| {
			status: "rejected" | "blocked";
			reasonCode: string;
			/** Which layer refused. A "memory" refusal rolled back the World write too. */
			stage: "host" | "world" | "memory";
			restore?: Extract<
				WorldOperationResult,
				{ status: "rejected" | "blocked" }
			>["restore"];
	  };

export type WorldReadResult =
	| WorldSnapshotResult
	| {
			status: "blocked";
			reasonCode:
				| "WORLD_DISABLED"
				| "STORE_CLOSING"
				| "WORLD_RECOVERY_REQUIRED";
	  };

export type WorldHistoryRequest = {
	access: WorldRequestAccess;
	scope: ScopeRef;
	assertionId: string;
	limit?: number;
};

export type WorldHistoryReadResult =
	| WorldHistoryResult
	| {
			status: "blocked";
			reasonCode: "WORLD_DISABLED" | "WORLD_RECOVERY_REQUIRED";
	  };

export type WorldUsageCheck =
	| WorldUsageResult
	| {
			status: "blocked";
			reasonCode: "WORLD_DISABLED" | "WORLD_RECOVERY_REQUIRED";
	  };

export type WorldSchemaStatus = "current" | "incompatible";

export type WorldStatus = {
	enabled: boolean;
	schema: WorldSchemaStatus;
	/** True only when World may be used: enabled and the schema matches the pinned migrations. */
	usable: boolean;
};

/** A source input after the host's scope check. */
export type ResolvedInput = {
	ref: SourceRef;
	type: "source" | "state_item";
};
