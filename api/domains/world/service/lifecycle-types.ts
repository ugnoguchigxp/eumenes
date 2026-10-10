import { type ScopeRef } from "eumenes-world-model";
import { type SqliteStore } from "../../../infrastructure/sqlite";
import { type SourceAdapter } from "../contracts";
import {
	type ForgetOrigin,
	type ForgetRoot,
	type ForgetState,
	type TombstoneReasonCode,
} from "../repository/lifecycle";
import type { WorldHostGate } from "./host-gate";
import { type MemoryPort } from "./lifecycle-memory";
import type { WorldService } from "./world-service";

/** Where in the flow a test may stop the process (by throwing from the hook). */
export type LifecyclePoint =
	| "accepted"
	| "journal_appended"
	| "journaled"
	| "world_chunk"
	| "world_call_done"
	| "world_applied"
	| "memory_batch"
	| "memory_confirmed"
	| "world_part_abandoned"
	| "before_reopen"
	| "complete"
	| "restore_begun"
	| "restore_registered"
	| "restore_reconciled"
	| "before_restore_finish"
	| "restore_finished"
	| "feed_cursor_saved";

export type LifecycleOptions = {
	store: SqliteStore;
	world: WorldService;
	/** Absolute path of the World journal file (owned by the host World domain). */
	journalPath: string;
	/** Startup gate. recoverWorld() opens it; pass the same gate to createWorldService. */
	gate?: WorldHostGate;
	/** AccessContext.purpose for the calls this adapter makes. */
	purpose?: string;
	/** Source adapters whose change outbox consumeSourceChanges reads. */
	sources?: readonly SourceAdapter[];
	/** Scopes to restore even when the database knows none (e.g. the default Scope). */
	scopes?: readonly ScopeRef[];
	clock?: () => number;
	/** Replace single Memory calls (tests); production uses the public API only. */
	memory?: Partial<MemoryPort>;
	/** World forget chunks one writer callback may apply before it commits and continues. */
	maxChunksPerCall?: number;
	/** External deletions confirmed per writer callback. */
	confirmBatch?: number;
	/** Dependents re-registered per page during a restore (default 100; tests use a small value). */
	dependentPageSize?: number;
	/** Test seam: throw to simulate a process crash at that point. */
	hook?: (point: LifecyclePoint, info: { forgetId?: string }) => void;
};

export type ForgetRequest = {
	forgetId: string;
	scope: ScopeRef;
	reasonCode: TombstoneReasonCode;
	roots: readonly { kind: ForgetRoot["kind"]; id: string; revision?: number }[];
	/**
	 * The Memory forget whose World dependents this forget owes confirmations
	 * for. It is a claim, not a license: an external of that forget is
	 * confirmed in Memory only when World content standing on it is verifiably
	 * gone (its host row is gone or released, or one of the inputs it stood on is
	 * among the roots erased by the intakes of this Memory forget). Externals the
	 * roots do not reach stay pending (blocked MEMORY_EXTERNAL_NOT_COVERED).
	 */
	memoryForgetId?: string;
	origin?: Exclude<ForgetOrigin, "restored">;
};

/** Honest status of one forget. `complete` only when every external deletion is confirmed. */
export type ForgetReport = {
	forgetId: string;
	state: ForgetState;
	complete: boolean;
	/** Why the last advance stopped before `complete` (null when complete or not yet tried). */
	blocked: string | null;
	/** World progress as of the last chunk this call applied. */
	world: {
		state: "pending" | "complete";
		processed: number;
		pending: number;
	} | null;
	/** Memory external deletions: total known and confirmed. null until Memory's receipt was read. */
	externals: { total: number; confirmed: number } | null;
	/**
	 * Parts / roots World permanently refused as invalid input and that the
	 * host therefore skipped (nothing stored can match such an id). A forget
	 * with any of them is NEVER reported `complete`, however far its state is.
	 */
	abandoned: { parts: number; roots: number };
};

/** One forget of a Scope as the owner may see it (metadata only, no root ids). */
export type ForgetListItem = ForgetReport & {
	origin: ForgetOrigin;
	rootCount: number;
	createdAt: number;
	updatedAt: number;
};

export type ForgetRefusal = {
	status: "rejected";
	reasonCode: "INVALID_INPUT" | "FORGET_CONFLICT" | "TOO_MANY_ROOTS";
};

export type RecoverReport =
	| {
			status: "open";
			restored: boolean;
			/** Forgets that still wait for Memory or the reopen (World content already deleted). */
			pendingForgets: string[];
			/** Forgets with parts or roots World permanently refused (see ForgetReport.abandoned). */
			abandonedForgets: string[];
	  }
	| { status: "closed"; reason: string };

export type ConsumeReport = {
	/** The persisted cursor was ignored (older restore epoch): everything is read again. */
	resync: boolean;
	changes: number;
	forgets: ForgetReport[];
	invalidated: number;
	hasMore: boolean;
	blocked: string | null;
	/** Roots of the change page that are not valid World ids and were skipped (never forgotten, never blocking). */
	rejectedRoots: number;
	/** Source feed only: extraction inputs World's inbox took in this pass (P4-01). */
	received?: number;
	/** Source feed only: inputs scanned while World was OFF (or its gate closed): never extracted. */
	skippedInputs?: number;
};
