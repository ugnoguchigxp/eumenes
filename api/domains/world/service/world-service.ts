import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../../../infrastructure/digest";
import type { AccessContext, SourceRef } from "eumenes-memory";
import type { CanonicalHasher, ScopeRef } from "eumenes-world-model";
import {
	applyWorldOperation,
	readAssertionHistory,
	readWorldSnapshot,
	validateWorldUsage,
	type HostChecks,
	type WorldOperation,
	type WorldOperationResult,
} from "eumenes-world-model/sqlite";
import {
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import type {
	SourceAdapter,
	WorldApplyRequest,
	WorldApplyResult,
	WorldFeed,
	WorldHistoryReadResult,
	WorldHistoryRequest,
	WorldReadRequest,
	WorldReadResult,
	WorldSchemaStatus,
	WorldStatus,
	WorldUsageCheck,
} from "../contracts";
import {
	readFeedCursor,
	readForgetEpoch,
	readHostState,
	WorldHostStateError,
	writeEnabled,
	writeFeedCursor,
	writeForgetEpoch,
	writeInitialSyncComplete,
	writeRestoreEpoch,
	type FeedCursorRow,
} from "../repository";
import { upsertDependent } from "../repository/lifecycle";
import {
	assertionSourceRefs,
	isMemoryStateItem,
	operationInputs,
	receiptSourceRefs,
	resolveSources,
} from "./inputs";
import {
	MemoryRegistrationRejected,
	planDependents,
	registerWorldDependents,
} from "./memory-adapter";
import type { WorldHostGate } from "./host-gate";

/**
 * Operations that only make World safer (stop, erase, restore). They keep
 * working while World is OFF: forgetting and corrections never wait for a flag.
 */
export const PROTECTIVE_KINDS: ReadonlySet<WorldOperation["kind"]> = new Set([
	"invalidate",
	"forget.chunk",
	"forget.reopen",
	"restore.begin",
	"restore.register",
	"restore.reconcile",
	"restore.finish",
	"rebuild",
]);

export type WorldServiceOptions = {
	store: SqliteStore;
	/** One adapter per source namespace. They are the scope check for every World input. */
	sources: readonly SourceAdapter[];
	/**
	 * The policy revision of the memory service's access(): it MUST be the same
	 * value, because World compares access, hostChecks and Memory's view of it.
	 */
	policyRevision: (db: Database) => string;
	/** Synchronous SHA-256 (hex). Defaults to node:crypto. */
	hasher?: CanonicalHasher;
	/** Opaque epoch tokens. Default: prefix plus a random UUID. */
	newToken?: (prefix: "restore" | "forget") => string;
	isStateItem?: (ref: SourceRef) => boolean;
	/** Inputs one derived version may have; above it the operation is refused, never truncated. */
	maxInputsPerVersion?: number;
	/**
	 * Startup gate (see createWorldHostGate). While closed, everything except
	 * the protective operations is blocked with WORLD_RECOVERY_REQUIRED.
	 * Omitted: always open.
	 */
	gate?: WorldHostGate;
};

const defaultHasher: CanonicalHasher = (bytes) => sha256Hex(bytes);
const defaultToken = (prefix: "restore" | "forget") =>
	`${prefix}-${randomUUID()}`;

type Done = Extract<WorldOperationResult, { status: "applied" | "no_op" }>;
const isDone = (result: WorldOperationResult): result is Done =>
	result.status === "applied" || result.status === "no_op";

const refusal = (
	status: "rejected" | "blocked",
	reasonCode: string,
	stage: "host" | "world" | "memory" = "host",
): WorldApplyResult => ({ status, reasonCode, stage });

/**
 * Composition of World, the host SourceAdapters and Memory. Thin glue: all
 * World semantics and SQL stay in `eumenes-world-model`; this file builds
 * hostChecks from the SAME connection the operation runs on, registers
 * Memory dependents in that transaction, and rolls everything back together.
 */
export function createWorldService(options: WorldServiceOptions) {
	const { store } = options;
	const hasher = options.hasher ?? defaultHasher;
	const newToken = options.newToken ?? defaultToken;
	const isStateItem = options.isStateItem ?? isMemoryStateItem;
	const adapters = new Map(options.sources.map((s) => [s.namespace, s]));
	if (adapters.size !== options.sources.length)
		throw new Error("duplicate_source_namespace");

	const accessOf = (
		db: Database,
		request: Pick<WorldApplyRequest, "access">,
	): AccessContext => ({
		principal: request.access.principal,
		scopeKeys: request.access.scopeKeys,
		purpose: request.access.purpose,
		policyRevision: options.policyRevision(db),
	});

	function hostChecks(
		db: Database,
		scope: ScopeRef,
		access: AccessContext,
		states: HostChecks["sourceSnapshot"]["states"],
	): HostChecks {
		return {
			gate: "open",
			sourceSnapshot: { states },
			forgetEpoch: readForgetEpoch(db, scope.principal, scope.scopeKey),
			restoreEpoch: readHostState(db).restoreEpoch,
			// The same value the access carries (and the memory service uses).
			policyRevision: access.policyRevision,
		};
	}

	function requireTransaction(db: Database) {
		if (!db.inTransaction)
			throw new WorldHostStateError("transaction_required");
	}

	/**
	 * Does the database carry exactly the pinned World migrations? World
	 * answers `blocked SCHEMA_INCOMPATIBLE` before touching any of its tables;
	 * an empty request therefore tells without reading or writing anything.
	 * Needs a transaction (writer callback or readSnapshot).
	 */
	function schemaInTransaction(db: Database): WorldSchemaStatus {
		requireTransaction(db);
		const probe = readWorldSnapshot(db, {});
		return probe.status === "blocked" &&
			probe.reasonCode === "SCHEMA_INCOMPATIBLE"
			? "incompatible"
			: "current";
	}

	function statusInTransaction(db: Database): WorldStatus {
		const { enabled } = readHostState(db);
		const schema = schemaInTransaction(db);
		return { enabled, schema, usable: enabled && schema === "current" };
	}

	/** Writer-side apply: throws MemoryRegistrationRejected so the caller's transaction rolls back. */
	function applyInWriter(
		db: Database,
		request: WorldApplyRequest,
	): WorldApplyResult {
		requireTransaction(db);
		const op = request.operation;
		if (!PROTECTIVE_KINDS.has(op?.kind)) {
			if (options.gate && !options.gate.isOpen())
				return refusal("blocked", "WORLD_RECOVERY_REQUIRED");
			if (!readHostState(db).enabled)
				return refusal("blocked", "WORLD_DISABLED");
		}
		const access = accessOf(db, request);
		const inputs = operationInputs(op);
		// Plan before any write: an over-large input set is refused, not cut off.
		const planned = planDependents(inputs.versions, request.scope, {
			isStateItem,
			...(options.maxInputsPerVersion === undefined
				? {}
				: { maxInputs: options.maxInputsPerVersion }),
		});
		if ("status" in planned) return refusal(planned.status, planned.reasonCode);
		// The scope check: every input is resolved through its host SourceAdapter.
		const resolved = resolveSources(
			db,
			adapters,
			access,
			request.scope,
			inputs.all,
			"strict",
			isStateItem,
		);
		if (!resolved.ok) return refusal(resolved.status, resolved.reasonCode);
		const result = applyWorldOperation(
			db,
			{
				contractVersion: 1,
				access,
				scope: request.scope,
				operationKey: request.operationKey,
				clock: request.clock,
				hostChecks: hostChecks(db, request.scope, access, resolved.states),
				operation: op,
			},
			{ hasher },
		);
		if (!isDone(result))
			return {
				status: result.status,
				reasonCode: result.reasonCode,
				stage: "world",
				...(result.restore === undefined ? {} : { restore: result.restore }),
			};
		// A replay (no_op) already registered in its own transaction.
		if (result.status === "no_op" || planned.dependents.length === 0)
			return result;
		const memory = registerWorldDependents(db, {
			access,
			scopeKey: request.scope.scopeKey,
			clockMs: request.clock,
			dependents: planned.dependents,
		});
		// What was registered, kept in the same transaction: a restore
		// re-registers exactly this set (ids only, no content).
		for (const dependent of planned.dependents)
			upsertDependent(
				db,
				request.scope.principal,
				request.scope.scopeKey,
				dependent.externalId,
				dependent.dependsOn.map((dependency) => ({
					type: dependency.type,
					id: dependency.id,
					key:
						planned.worldKeys.get(`${dependency.type}\u0000${dependency.id}`) ??
						dependency.id,
				})),
			);
		return { ...result, memory };
	}

	/** Maps the failures that mean "nothing was written" to typed results. */
	function typedFailure(error: unknown): WorldApplyResult {
		if (error instanceof MemoryRegistrationRejected)
			return refusal(error.status, error.reasonCode, "memory");
		if (error instanceof WriterBusyError)
			return refusal("blocked", "WRITER_BUSY");
		if (error instanceof Error && error.message === "database_closing")
			return refusal("blocked", "STORE_CLOSING");
		throw error;
	}

	/** Read inside one snapshot (readonly reader or writer). Two passes, one consistent view. */
	function readSnapshotInTransaction(
		db: Database,
		request: WorldReadRequest,
	): WorldReadResult {
		requireTransaction(db);
		if (options.gate && !options.gate.isOpen())
			return { status: "blocked", reasonCode: "WORLD_RECOVERY_REQUIRED" };
		if (!readHostState(db).enabled)
			return { status: "blocked", reasonCode: "WORLD_DISABLED" };
		const access = accessOf(db, request);
		const build = (states: HostChecks["sourceSnapshot"]["states"]) => ({
			contractVersion: 1,
			access,
			scope: request.scope,
			asOf: request.asOf,
			...(request.focus === undefined ? {} : { focus: request.focus }),
			...(request.budget === undefined ? {} : { budget: request.budget }),
			hostChecks: hostChecks(db, request.scope, access, states),
		});
		// Pass 1 learns which sources the returned assertions stand on.
		const first = readWorldSnapshot(db, build([]));
		if (first.status !== "ready") return first;
		const wanted = assertionSourceRefs(first.snapshot.assertions);
		if (wanted.length === 0) return first;
		const resolved = resolveSources(
			db,
			adapters,
			accessOf(db, request),
			request.scope,
			wanted,
			"lenient",
			isStateItem,
		);
		return readWorldSnapshot(db, build(resolved.ok ? resolved.states : []));
	}

	/**
	 * Revision history of ONE assertion, newest first. Not a side door: the
	 * gate, tombstone and access checks of a normal read apply again.
	 */
	function readHistoryInTransaction(
		db: Database,
		request: WorldHistoryRequest,
	): WorldHistoryReadResult {
		requireTransaction(db);
		if (options.gate && !options.gate.isOpen())
			return { status: "blocked", reasonCode: "WORLD_RECOVERY_REQUIRED" };
		if (!readHostState(db).enabled)
			return { status: "blocked", reasonCode: "WORLD_DISABLED" };
		const access = accessOf(db, request);
		return readAssertionHistory(db, {
			contractVersion: 1,
			access,
			scope: request.scope,
			hostChecks: hostChecks(db, request.scope, access, []),
			assertionId: request.assertionId,
			...(request.limit === undefined ? {} : { limit: request.limit }),
		});
	}

	function validateUsageInTransaction(
		db: Database,
		receipt: unknown,
		request: Pick<WorldReadRequest, "access" | "scope">,
	): WorldUsageCheck {
		requireTransaction(db);
		if (options.gate && !options.gate.isOpen())
			return { status: "blocked", reasonCode: "WORLD_RECOVERY_REQUIRED" };
		if (!readHostState(db).enabled)
			return { status: "blocked", reasonCode: "WORLD_DISABLED" };
		const access = accessOf(db, request);
		const resolved = resolveSources(
			db,
			adapters,
			access,
			request.scope,
			receiptSourceRefs(receipt),
			"lenient",
			isStateItem,
		);
		return validateWorldUsage(db, receipt, {
			contractVersion: 1,
			access,
			scope: request.scope,
			hostChecks: hostChecks(
				db,
				request.scope,
				access,
				resolved.ok ? resolved.states : [],
			),
		});
	}

	return {
		/** ON/OFF state and whether the installed schema matches the pinned migrations. */
		statusInTransaction,
		status: (): WorldStatus =>
			store.readSnapshot((db) => statusInTransaction(db)),
		/**
		 * Default OFF. Turning it ON does not override a schema mismatch, and is
		 * refused (WorldHostStateError "initial_sync_required") until the host
		 * recorded `markInitialSyncComplete`: forgets and corrections that
		 * happened before World existed must have been consumed first.
		 */
		setEnabled: (enabled: boolean): Promise<void> =>
			store.write((db) => writeEnabled(db, enabled)),
		setEnabledInWriter: writeEnabled,
		/** True once the host recorded `markInitialSyncComplete` (turning World ON needs it). */
		initialSyncComplete: (): boolean =>
			store.readSnapshot((db) => readHostState(db).initialSyncComplete),
		/** The host's explicit statement that the first full feed pass is done. */
		markInitialSyncComplete: (): Promise<void> =>
			store.write((db) => writeInitialSyncComplete(db, true)),
		markInitialSyncCompleteInWriter: (db: Database): void =>
			writeInitialSyncComplete(db, true),

		/** The AccessContext a request gets (with the policy revision Memory also sees). */
		accessInTransaction: accessOf,
		applyInWriter,
		/** One World operation in its own writer transaction, with typed refusals. */
		async apply(request: WorldApplyRequest): Promise<WorldApplyResult> {
			try {
				return await store.write((db) => applyInWriter(db, request));
			} catch (error) {
				return typedFailure(error);
			}
		},
		typedFailure,

		readSnapshot: readSnapshotInTransaction,
		readHistory: readHistoryInTransaction,
		async read(request: WorldReadRequest): Promise<WorldReadResult> {
			try {
				return store.readSnapshot((db) =>
					readSnapshotInTransaction(db, request),
				);
			} catch (error) {
				if (error instanceof Error && error.message === "database_closing")
					return { status: "blocked", reasonCode: "STORE_CLOSING" };
				throw error;
			}
		},
		/** Run on the writer connection (pre-adoption check with the answer). */
		validateUsageInWriter: validateUsageInTransaction,
		validateUsage: (
			receipt: unknown,
			request: Pick<WorldReadRequest, "access" | "scope">,
		): Promise<WorldUsageCheck> =>
			store.write((db) => validateUsageInTransaction(db, receipt, request)),

		// Host epochs. Opaque tokens; the host bumps them, World only compares.
		restoreEpoch: (db: Database): string => readHostState(db).restoreEpoch,
		forgetEpoch: (db: Database, scope: ScopeRef): string =>
			readForgetEpoch(db, scope.principal, scope.scopeKey),
		bumpRestoreEpochInWriter(db: Database): string {
			const token = newToken("restore");
			writeRestoreEpoch(db, token);
			return token;
		},
		bumpForgetEpochInWriter(db: Database, scope: ScopeRef): string {
			const token = newToken("forget");
			writeForgetEpoch(db, scope.principal, scope.scopeKey, token);
			return token;
		},

		// Feed cursors, valid only for the restore epoch that issued them.
		feedCursor: (
			db: Database,
			feed: WorldFeed,
			scope: ScopeRef,
		): FeedCursorRow =>
			readFeedCursor(db, feed, scope.principal, scope.scopeKey),
		saveFeedCursorInWriter: (
			db: Database,
			feed: WorldFeed,
			scope: ScopeRef,
			cursor: string,
		): void =>
			writeFeedCursor(db, feed, scope.principal, scope.scopeKey, cursor),
	};
}
export type WorldService = ReturnType<typeof createWorldService>;
