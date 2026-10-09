import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { MemoryStoreError } from "eumenes-memory/sqlite";
import { type AccessContext, type MemoryChange } from "eumenes-memory";
import {
	checkOpaque,
	checkRevision,
	isWellFormed,
	type ScopeRef,
} from "eumenes-world-model";
import {
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import {
	WORLD_PROVIDER_REF,
	type SourceAdapter,
	type WorldApplyRequest,
	type WorldApplyResult,
} from "../contracts";
import {
	advanceIntake,
	allIntakeIds,
	countUnconfirmed,
	dropFeedCursors,
	getDependent,
	getIntake,
	insertIntake,
	intakesWithJournal,
	listConfirmations,
	listDependents,
	listIntakesOfMemoryForget,
	listKnownScopes,
	listMemoryLinkedIntakes,
	listOpenIntakes,
	readRestore,
	reopenIntakeForMemory,
	setBlockedReason,
	setWorldProgress,
	stateAtLeast,
	upsertConfirmation,
	writeRestore,
	TOMBSTONE_REASONS,
	ROOT_KINDS,
	type DependentRow,
	type ForgetOrigin,
	type ForgetRoot,
	type ForgetState,
	type IntakeRow,
	type TombstoneReasonCode,
} from "../repository/lifecycle";
import {
	listAbandoned,
	listAbandonedForgetIds,
	recordAbandoned,
	type AbandonedPart,
} from "../repository/guard";
import {
	purgeUnsettledExtractEvents,
	writeExtractFeedScopeSet,
} from "../repository/extraction";
import {
	purgeRuntimeObservations,
	runtimeOutcomeRootsOfSources,
} from "../repository/runtime";
import {
	candidateRootsFor,
	memoryFeedStages,
	purgeForgotten,
	receiveSourceChanges,
	scopeSetChanged,
	scopeSetOf,
	sourceFeedStages,
	type FeedStages,
} from "./extraction-intake";
import type { WorldHostGate } from "./host-gate";
import { sourceKeyOf } from "./inputs";
import { defaultMemoryPort, type MemoryPort } from "./lifecycle-memory";
import { deletionsFirst } from "./source-adapter";
import {
	forgetUsageInScope,
	sweepReleasePending,
	type UnregisterDependents,
} from "./usage-ledger";
import {
	WorldJournalCorruptError,
	appendWorldJournal,
	readWorldJournal,
	type WorldJournalEntry,
} from "./world-journal";
import type { WorldService } from "./world-service";

const MAX_CHUNK_ROOTS = 500;
const MAX_ROOTS_PER_FORGET = 50_000;
const MAX_REGISTRATIONS = 200;
const MAX_TOMBSTONES = 200;
const FEED_PAGE = 500;
const FEED_MAX_ROWS = 5000;
const INVALIDATE_KEYS = 20;
const MAX_ID_BYTES = 200;
/** Splits a forget id from its part number; reserved, so a caller id may not contain it. */
const PART_SEPARATOR = "~";
const DEFAULT_DEPENDENT_PAGE = 100;

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");
const short = (text: string) => sha256(text).slice(0, 24);
const utf8 = (text: string) => new TextEncoder().encode(text).length;

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

class StepBlocked extends Error {
	constructor(readonly reason: string) {
		super(`world_lifecycle_${reason.toLowerCase()}`);
	}
}

const memoryUnavailable = (error: unknown): boolean =>
	error instanceof MemoryStoreError;
const transientReason = (error: unknown): string | null => {
	if (error instanceof WriterBusyError) return "WRITER_BUSY";
	if (error instanceof Error && error.message === "database_closing")
		return "STORE_CLOSING";
	if (memoryUnavailable(error)) return "MEMORY_UNAVAILABLE";
	if (error instanceof StepBlocked) return error.reason;
	if (error instanceof WorldJournalCorruptError) return "JOURNAL_CORRUPT";
	return null;
};

const rootDigest = (roots: readonly ForgetRoot[]): string =>
	sha256(
		JSON.stringify(
			[...roots]
				.map((r) => [r.kind, r.id, r.revision] as const)
				.sort((a, b) =>
					a[0] === b[0]
						? a[1] === b[1]
							? a[2] - b[2]
							: a[1] < b[1]
								? -1
								: 1
						: a[0] < b[0]
							? -1
							: 1,
				),
		),
	);

/**
 * The stored roots of an intake are the requested ones, plus `candidate` roots
 * the host added for extraction events (P4-01). Used to recognise a resend.
 */
function rootsCover(
	existing: Pick<IntakeRow, "roots">,
	requested: readonly ForgetRoot[],
): boolean {
	return (
		requested.every((r) =>
			existing.roots.some(
				(x) => x.kind === r.kind && x.id === r.id && x.revision === r.revision,
			),
		) &&
		existing.roots.every(
			(x) =>
				x.kind === "candidate" ||
				x.kind === "outcome" ||
				requested.some((r) => r.kind === x.kind && r.id === x.id),
		)
	);
}

/**
 * The same id rules World applies to a forget root (`checkTargetRef`): the
 * kind is known, source/state ids may be 8192 bytes, every other kind 256,
 * ids are non-empty and well-formed (no lone surrogates), revision >= 1.
 */
export function isValidRoot(root: {
	kind: unknown;
	id: unknown;
	revision?: unknown;
}): boolean {
	if (!(ROOT_KINDS as readonly string[]).includes(root.kind as string))
		return false;
	const long = root.kind === "source" || root.kind === "state";
	return (
		checkOpaque(root.id, "id", long ? 8192 : 256).ok &&
		checkRevision(root.revision ?? 1, "revision").ok
	);
}

/** Well-formed id of a forget; the part separator is reserved. */
const validForgetId = (id: unknown, allowSeparator: boolean): boolean =>
	typeof id === "string" &&
	id !== "" &&
	isWellFormed(id) &&
	utf8(id) <= MAX_ID_BYTES &&
	(allowSeparator || !id.includes(PART_SEPARATOR));

function normalizeRoots(
	roots: ForgetRequest["roots"],
): ForgetRoot[] | ForgetRefusal {
	if (roots.length === 0)
		return { status: "rejected", reasonCode: "INVALID_INPUT" };
	if (roots.length > MAX_ROOTS_PER_FORGET)
		return { status: "rejected", reasonCode: "TOO_MANY_ROOTS" };
	const seen = new Set<string>();
	const out: ForgetRoot[] = [];
	for (const root of roots) {
		if (!isValidRoot(root))
			return { status: "rejected", reasonCode: "INVALID_INPUT" };
		const revision = root.revision ?? 1;
		const slot = JSON.stringify([root.kind, root.id, revision]);
		if (seen.has(slot)) continue;
		seen.add(slot);
		out.push({ kind: root.kind, id: root.id, revision });
	}
	return out;
}

/** Feeds: roots that are not valid World ids are counted and skipped, the rest still go. */
function splitValidRoots<T extends { kind: string; id: string }>(
	roots: readonly T[],
): { valid: T[]; rejected: number } {
	const valid = roots.filter((root) => isValidRoot(root));
	return { valid, rejected: roots.length - valid.length };
}

const stateItemKey = (itemId: string) =>
	sourceKeyOf({ namespace: "memory", kind: "state_item", id: itemId });
/** Memory's recordSourceKey: namespace memory, kind record, representation text. */
const recordKey = (recordId: string) =>
	sourceKeyOf({
		namespace: "memory",
		kind: "record",
		id: recordId,
		representation: "text",
	});

/** The reason a World result was not applied. */
const why = (result: WorldApplyResult): string =>
	"reasonCode" in result ? result.reasonCode : "NOT_APPLIED";

const chunk = <T>(items: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
};

/**
 * World forget / restore lifecycle on the host side (P3-05). It owns the
 * forget intake state machine, the World journal, the restore procedure and
 * the two change-feed consumers. Everything that touches World or Memory
 * data runs in the host's single Writer callback; nothing here opens a
 * transaction of its own. Memory is reached only through its public sqlite
 * API (MemoryPort).
 */
export function createWorldLifecycle(options: LifecycleOptions) {
	const { store, world } = options;
	const purpose = options.purpose ?? "world.lifecycle";
	const now = options.clock ?? (() => Date.now());
	const memory: MemoryPort = { ...defaultMemoryPort, ...options.memory };
	const maxChunks = options.maxChunksPerCall ?? 50;
	const confirmBatch = options.confirmBatch ?? 50;
	const dependentPage = options.dependentPageSize ?? DEFAULT_DEPENDENT_PAGE;
	const hook = (point: LifecyclePoint, forgetId?: string) =>
		options.hook?.(point, forgetId === undefined ? {} : { forgetId });
	const adapters = new Map(
		(options.sources ?? []).map((s) => [s.namespace, s]),
	);

	// In-process serialisation per forgetId (the Writer serialises the DML itself).
	const locks = new Map<string, Promise<unknown>>();
	function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		const next = previous.then(run, run);
		const tail = next.catch(() => undefined);
		locks.set(key, tail);
		void tail.then(() => {
			if (locks.get(key) === tail) locks.delete(key);
		});
		return next;
	}

	const accessFor = (db: Database, scope: ScopeRef): AccessContext =>
		world.accessInTransaction(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
		});

	/** Memory unregistration of World dependents of one Scope (refusal -> "blocked", rows kept). */
	const unregisterFor =
		(db: Database, scope: ScopeRef): UnregisterDependents =>
		(ids) =>
			memory.unregister(
				db,
				accessFor(db, scope),
				now(),
				scope.scopeKey,
				ids.map((externalId) => ({
					providerRef: WORLD_PROVIDER_REF,
					externalId,
				})),
			);

	function worldOp(
		db: Database,
		scope: ScopeRef,
		operationKey: string,
		operation: WorldApplyRequest["operation"],
	): WorldApplyResult {
		const result = world.applyInWriter(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
			scope,
			operationKey,
			clock: now(),
			operation,
		});
		// Answers that stood on this Scope's material lose their usage receipts with it.
		if (
			operation.kind === "forget.chunk" &&
			(result.status === "applied" || result.status === "no_op")
		)
			forgetUsageInScope(db, scope, unregisterFor(db, scope));
		return result;
	}

	const scopeOf = (row: IntakeRow): ScopeRef => ({
		principal: row.principal,
		scopeKey: row.scopeKey,
	});

	// --- intake ---------------------------------------------------------------

	/** Idempotent: the same id with the same content is a no-op; other content is a conflict. */
	function acceptInWriter(
		db: Database,
		request: ForgetRequest,
		extra: { memoryFinal?: boolean } = {},
	): ForgetRefusal | { forgetId: string; created: boolean } {
		const requested = normalizeRoots(request.roots);
		if ("status" in requested) return requested;
		// World cannot reach an unsettled inbox event from its source: name the
		// extraction events these sources fed as `candidate` roots (P4-01).
		const roots: ForgetRoot[] = [...requested];
		const candidates = candidateRootsFor(
			db,
			request.scope,
			requested.filter((r) => r.kind === "source").map((r) => r.id),
		).filter((r) => !roots.some((x) => x.kind === r.kind && x.id === r.id));
		roots.push(...candidates);
		// World's closure from a source does not reach Outcomes either: the
		// runtime observations (P4-04) that stand on these sources are named too.
		const sourceKeys = requested
			.filter((r) => r.kind === "source")
			.map((r) => r.id);
		for (const outcome of runtimeOutcomeRootsOfSources(
			db,
			request.scope.principal,
			request.scope.scopeKey,
			sourceKeys,
		))
			if (
				!roots.some(
					(x) =>
						x.kind === outcome.kind &&
						x.id === outcome.id &&
						x.revision === outcome.revision,
				)
			)
				roots.push(outcome);
		if (
			!validForgetId(request.forgetId, false) ||
			!(TOMBSTONE_REASONS as readonly string[]).includes(request.reasonCode) ||
			(request.memoryForgetId !== undefined &&
				!validForgetId(request.memoryForgetId, true))
		)
			return { status: "rejected", reasonCode: "INVALID_INPUT" };
		const digest = rootDigest(roots);
		const existing = getIntake(db, request.forgetId);
		if (existing) {
			// A resend finds the extraction events already purged: the stored roots
			// are then the requested ones plus candidate roots (P4-01).
			const covers =
				existing.rootsDigest === digest || rootsCover(existing, requested);
			const same =
				existing.principal === request.scope.principal &&
				existing.scopeKey === request.scope.scopeKey &&
				existing.reasonCode === request.reasonCode &&
				covers &&
				existing.memoryForgetId === (request.memoryForgetId ?? null);
			return same
				? { forgetId: request.forgetId, created: false }
				: { status: "rejected", reasonCode: "FORGET_CONFLICT" };
		}
		insertIntake(
			db,
			{
				forgetId: request.forgetId,
				principal: request.scope.principal,
				scopeKey: request.scope.scopeKey,
				memoryForgetId: request.memoryForgetId ?? null,
				memoryFinal: extra.memoryFinal ?? true,
				reasonCode: request.reasonCode,
				origin: request.origin ?? "request",
				roots,
				rootsDigest: digest,
			},
			now(),
		);
		// The host's own record of the forgotten extraction inputs goes with it.
		purgeForgotten(db, request.scope, roots);
		purgeRuntimeObservations(
			db,
			request.scope.principal,
			request.scope.scopeKey,
			roots.filter((r) => r.kind === "source").map((r) => r.id),
		);
		// Defense in depth: an answer prepared before this forget can never be
		// adopted afterwards, whatever World's own epoch checks say.
		world.bumpForgetEpochInWriter(db, request.scope);
		return { forgetId: request.forgetId, created: true };
	}

	function reportOf(
		db: Database,
		intake: IntakeRow,
		extra: Partial<Pick<ForgetReport, "blocked" | "world" | "externals">> = {},
	): ForgetReport {
		const abandoned = listAbandoned(db, intake.forgetId);
		const parts = abandoned.filter((a) => a.wholePart).length;
		const roots = abandoned.reduce((sum, a) => sum + a.skippedRoots, 0);
		const clean = parts === 0 && roots === 0;
		return {
			forgetId: intake.forgetId,
			state: intake.state,
			// Never complete while World refused some of what was asked.
			complete: intake.state === "complete" && clean,
			blocked:
				intake.state === "complete"
					? clean
						? null
						: "WORLD_ROOTS_ABANDONED"
					: (extra.blocked ?? intake.blockedReason),
			world: extra.world ?? null,
			externals: extra.externals ?? null,
			abandoned: { parts, roots },
		};
	}

	const report = (
		forgetId: string,
		extra: Partial<Pick<ForgetReport, "blocked" | "world" | "externals">> = {},
	): ForgetReport =>
		store.read((db) => reportOf(db, getIntake(db, forgetId)!, extra));

	// --- step 2: World journal (fsync) -------------------------------------------

	async function journalStep(intake: IntakeRow): Promise<void> {
		await store.write((db) => {
			const row = getIntake(db, intake.forgetId);
			if (!row || row.state !== "pending") return;
			// Idempotent per forgetId: a crash after the append repeats this safely.
			const entry = appendWorldJournal(options.journalPath, {
				forgetId: row.forgetId,
				memoryForgetId: row.memoryForgetId,
				principal: row.principal,
				scopeKey: row.scopeKey,
				reasonCode: row.reasonCode,
				roots: row.roots,
			});
			hook("journal_appended", row.forgetId);
			advanceIntake(db, row.forgetId, "pending", "journaled", now(), {
				journalSeq: entry.seq,
				journalHash: entry.hash,
			});
		});
		hook("journaled", intake.forgetId);
	}

	// --- step 3: World forget, resumable chunks ----------------------------------

	const forgetKey = (forgetId: string, kind: string, n: number | string) =>
		`wl:${short(forgetId)}:${kind}:${n}`;
	/**
	 * World closes a forget as soon as every root it was GIVEN is erased, so a
	 * later chunk of roots for the same id would be refused. More than 500 roots
	 * therefore become several World forgets ("parts"): part 0 keeps the id,
	 * part n is `<id>~n`. Each part is resumable on its own.
	 */
	const partId = (forgetId: string, part: number) =>
		part === 0 ? forgetId : `${forgetId}${PART_SEPARATOR}${part}`;
	const partCount = (row: IntakeRow) =>
		Math.max(1, Math.ceil(row.roots.length / MAX_CHUNK_ROOTS));

	async function worldStep(intake: IntakeRow): Promise<{
		progress: ForgetReport["world"];
		blocked: string | null;
	}> {
		let last: ForgetReport["world"] = null;
		let blocked: string | null = null;
		for (;;) {
			const out = await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "journaled")
					return { done: true as const, blocked: null, progress: null };
				const scope = scopeOf(row);
				const parts = partCount(row);
				let part = row.worldPart;
				let chunks = row.worldChunks;
				let progress: ForgetReport["world"] = null;
				for (let applied = 0; applied < maxChunks && part < parts; applied++) {
					const id = partId(row.forgetId, part);
					let roots: ForgetRoot[] = [];
					if (chunks === 0) {
						// Roots World would refuse as ids are skipped (and said so), never
						// allowed to block the valid ones of the same part.
						const given = row.roots.slice(
							part * MAX_CHUNK_ROOTS,
							(part + 1) * MAX_CHUNK_ROOTS,
						);
						const split = splitValidRoots(given);
						roots = split.valid;
						if (roots.length === 0) {
							// Nothing in this part can name stored data: no World forget exists.
							recordAbandoned(
								db,
								{
									forgetId: row.forgetId,
									part,
									skippedRoots: given.length,
									wholePart: true,
									reason: "NO_VALID_ROOTS",
								},
								now(),
							);
							part += 1;
							chunks = 0;
							setWorldProgress(db, row.forgetId, part, chunks, now());
							hook("world_part_abandoned", row.forgetId);
							continue;
						}
						if (split.rejected > 0)
							recordAbandoned(
								db,
								{
									forgetId: row.forgetId,
									part,
									skippedRoots: split.rejected,
									wholePart: false,
									reason: "INVALID_ROOT_ID",
								},
								now(),
							);
					}
					const result = worldOp(
						db,
						scope,
						forgetKey(id, chunks === 0 ? "rc" : "dr", chunks),
						{
							kind: "forget.chunk",
							forgetId: id,
							reasonCode: row.reasonCode,
							roots,
						},
					);
					if (
						chunks === 0 &&
						result.status === "rejected" &&
						(result.reasonCode === "INVALID_INPUT" ||
							result.reasonCode === "LIMIT_EXCEEDED")
					) {
						// World refuses this part for good and wrote nothing (its checks run
						// before the first write). An explicit durable terminal, reported and
						// never counted as complete, instead of a gate that never opens.
						recordAbandoned(
							db,
							{
								forgetId: row.forgetId,
								part,
								skippedRoots: roots.length,
								wholePart: true,
								reason: `WORLD_${result.reasonCode}`,
							},
							now(),
						);
						part += 1;
						chunks = 0;
						setWorldProgress(db, row.forgetId, part, chunks, now());
						hook("world_part_abandoned", row.forgetId);
						continue;
					}
					if (result.status !== "applied" && result.status !== "no_op") {
						// A part that is already complete is never an excuse to skip
						// roots: parts only get roots in their first op, so this is a refusal.
						const reason = `WORLD_${why(result)}`;
						setBlockedReason(db, row.forgetId, reason, now());
						return { done: false as const, blocked: reason, progress };
					}
					chunks += 1;
					setWorldProgress(db, row.forgetId, part, chunks, now());
					hook("world_chunk", row.forgetId);
					const forget = result.forget;
					if (forget === undefined)
						throw new StepBlocked("WORLD_PROGRESS_MISSING");
					progress = {
						state: forget.state,
						processed: forget.processed,
						pending: forget.pending,
					};
					if (forget.state !== "complete") continue;
					// Verified: a further chunk of a complete forget is refused as such.
					const verify = worldOp(db, scope, forgetKey(id, "vf", chunks), {
						kind: "forget.chunk",
						forgetId: id,
						reasonCode: row.reasonCode,
						roots: [],
					});
					if (
						!(
							verify.status === "rejected" &&
							verify.reasonCode === "FORGET_ALREADY_COMPLETE"
						)
					)
						throw new StepBlocked("WORLD_NOT_VERIFIED");
					part += 1;
					chunks = 0;
					setWorldProgress(db, row.forgetId, part, chunks, now());
				}
				if (part < parts)
					return { done: false as const, blocked: null, progress };
				advanceIntake(db, row.forgetId, "journaled", "world_applied", now());
				// The World content is gone: any answer still in flight is stale.
				world.bumpForgetEpochInWriter(db, scope);
				return { done: true as const, blocked: null, progress };
			});
			if (out.progress) last = out.progress;
			if (out.blocked !== null) {
				blocked = out.blocked;
				break;
			}
			hook("world_call_done", intake.forgetId);
			if (out.done) break;
		}
		return { progress: last, blocked };
	}

	// --- step 4: Memory external deletions ---------------------------------------

	/**
	 * Roots (source/state keys) the intakes of one Memory forget have erased from
	 * World: only intakes whose World deletion is verified count.
	 */
	function erasedKeys(db: Database, memoryForgetId: string): Set<string> {
		const keys = new Set<string>();
		for (const intake of listIntakesOfMemoryForget(db, memoryForgetId)) {
			if (!stateAtLeast(intake.state, "world_applied")) continue;
			for (const root of intake.roots)
				if (root.kind === "source" || root.kind === "state") keys.add(root.id);
		}
		return keys;
	}

	/**
	 * May Memory be told that World deleted this external? Only when World
	 * content standing on it is gone: the host row is gone (released / purged),
	 * the row waits for its release, or an input it stood on is among the roots
	 * erased for this Memory forget (World erases every version that stands on
	 * an erased root, whatever its other inputs are). A forget with unrelated
	 * roots therefore confirms nothing.
	 */
	function externalErased(
		db: Database,
		scope: ScopeRef,
		externalId: string,
		erased: ReadonlySet<string>,
	): boolean {
		const dependent = getDependent(
			db,
			scope.principal,
			scope.scopeKey,
			externalId,
		);
		if (dependent === null || dependent.releasePending) return true;
		return dependent.dependsOn.some((d) => erased.has(d.key));
	}

	/**
	 * Reads Memory's receipt, syncs the per-externalId rows to it (a row Memory
	 * no longer shows as confirmed goes back to pending) and sorts what is
	 * still owed: `confirmable` (the World content is verifiably gone) and
	 * `uncovered` (the roots given do not reach it: never confirmed). Needs the
	 * World deletion to be verified (state world_applied or later).
	 */
	function syncConfirmations(
		db: Database,
		row: IntakeRow,
	): { confirmable: string[]; uncovered: string[]; total: number } {
		const mid = row.memoryForgetId!;
		const receipt = memory.receipt(db, accessFor(db, scopeOf(row)), mid);
		if (receipt.status === "missing")
			throw new StepBlocked("MEMORY_RECEIPT_MISSING");
		if (receipt.status !== "found")
			throw new StepBlocked("MEMORY_NOT_PERMITTED");
		for (const external of receipt.externals)
			upsertConfirmation(
				db,
				mid,
				external.externalId,
				external.state === "confirmed" ? "confirmed" : "pending",
				now(),
			);
		const rows = listConfirmations(db, mid);
		const erased = erasedKeys(db, mid);
		const scope = scopeOf(row);
		const confirmable: string[] = [];
		const uncovered: string[] = [];
		for (const r of rows) {
			if (r.state === "confirmed") continue;
			(externalErased(db, scope, r.externalId, erased)
				? confirmable
				: uncovered
			).push(r.externalId);
		}
		return { confirmable, uncovered, total: rows.length };
	}

	/** Every intake of this Memory forget has deleted its World content, and the last batch is the final one. */
	const groupReady = (db: Database, memoryForgetId: string): boolean => {
		const group = listIntakesOfMemoryForget(db, memoryForgetId);
		return (
			group.length > 0 &&
			group.every((r) => stateAtLeast(r.state, "world_applied")) &&
			group[group.length - 1]!.memoryFinal
		);
	};

	async function memoryStep(
		intake: IntakeRow,
	): Promise<{ externals: ForgetReport["externals"]; blocked: string | null }> {
		if (intake.memoryForgetId === null) {
			await store.write((db) => {
				advanceIntake(
					db,
					intake.forgetId,
					"world_applied",
					"memory_confirmed",
					now(),
				);
			});
			hook("memory_confirmed", intake.forgetId);
			return { externals: null, blocked: null };
		}
		const mid = intake.memoryForgetId;
		let externals: ForgetReport["externals"] = null;
		try {
			// Phase 1: read Memory's receipt and sync rows; refuse while the group is incomplete.
			const first = await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "world_applied")
					return {
						confirmable: [] as string[],
						uncovered: [] as string[],
						total: 0,
						skip: true,
					};
				if (!groupReady(db, mid))
					throw new StepBlocked("WAITING_FOR_FORGET_GROUP");
				return { ...syncConfirmations(db, row), skip: false };
			});
			if (first.skip) return { externals, blocked: null };
			externals = {
				total: first.total,
				confirmed:
					first.total - first.confirmable.length - first.uncovered.length,
			};
			// Phase 2: confirm in bounded batches, each its own transaction.
			let pending = first.confirmable;
			while (pending.length > 0) {
				const batch = pending.slice(0, confirmBatch);
				const rest = await store.write((db) => {
					const row = getIntake(db, intake.forgetId);
					if (!row || row.state !== "world_applied") return pending;
					const access = accessFor(db, scopeOf(row));
					for (const externalId of batch) {
						const outcome = memory.record(db, access, now(), {
							forgetId: mid,
							externalId,
							state: "confirmed",
						});
						if (outcome !== "recorded")
							throw new StepBlocked(`MEMORY_${outcome.toUpperCase()}`);
						upsertConfirmation(db, mid, externalId, "confirmed", now());
					}
					return pending.slice(batch.length);
				});
				pending = rest;
				externals = {
					total: first.total,
					confirmed: first.total - pending.length - first.uncovered.length,
				};
				hook("memory_batch", intake.forgetId);
			}
			// Phase 3: re-read Memory; only a receipt that shows everything confirmed moves on.
			await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "world_applied") return;
				const check = syncConfirmations(db, row);
				if (check.uncovered.length > 0)
					throw new StepBlocked("MEMORY_EXTERNAL_NOT_COVERED");
				if (check.confirmable.length > 0 || countUnconfirmed(db, mid) > 0)
					throw new StepBlocked("MEMORY_UNCONFIRMED");
				advanceIntake(
					db,
					row.forgetId,
					"world_applied",
					"memory_confirmed",
					now(),
				);
			});
			hook("memory_confirmed", intake.forgetId);
			return { externals, blocked: null };
		} catch (error) {
			// Keep what was confirmed so far in the report; the rest stays owed.
			if (error instanceof StepBlocked)
				return { externals, blocked: error.reason };
			throw error;
		}
	}

	// --- step 5: reopen -----------------------------------------------------------

	async function reopenStep(intake: IntakeRow): Promise<string | null> {
		hook("before_reopen", intake.forgetId);
		return store.write((db) => {
			const row = getIntake(db, intake.forgetId);
			if (!row || row.state !== "memory_confirmed") return null;
			if (
				row.memoryForgetId !== null &&
				countUnconfirmed(db, row.memoryForgetId) > 0
			)
				throw new StepBlocked("MEMORY_UNCONFIRMED");
			if (row.origin !== "restored") {
				// A part World refused outright never became a World forget.
				const absent = new Set(
					listAbandoned(db, row.forgetId)
						.filter((a: AbandonedPart) => a.wholePart)
						.map((a) => a.part),
				);
				for (let part = 0; part < partCount(row); part++) {
					if (absent.has(part)) continue;
					const id = partId(row.forgetId, part);
					const result = worldOp(db, scopeOf(row), forgetKey(id, "ro", 0), {
						kind: "forget.reopen",
						forgetId: id,
						externalDeletionConfirmed: true,
					});
					const done =
						result.status === "applied" ||
						result.status === "no_op" ||
						(result.status === "blocked" &&
							result.reasonCode === "FORGET_NOT_AWAITING");
					if (!done) {
						const reason = `WORLD_${why(result)}`;
						setBlockedReason(db, row.forgetId, reason, now());
						return reason;
					}
				}
			}
			advanceIntake(db, row.forgetId, "memory_confirmed", "complete", now());
			return null;
		});
	}

	// --- driver -------------------------------------------------------------------

	function advance(forgetId: string): Promise<ForgetReport> {
		return withLock(forgetId, async () => {
			let world: ForgetReport["world"] = null;
			let externals: ForgetReport["externals"] = null;
			let blocked: string | null = null;
			for (let guard = 0; guard < 16; guard++) {
				const intake = store.read((db) => getIntake(db, forgetId));
				if (!intake) throw new Error("world_forget_unknown");
				if (intake.state === "complete") break;
				try {
					if (intake.state === "pending") await journalStep(intake);
					else if (intake.state === "journaled") {
						const out = await worldStep(intake);
						world = out.progress ?? world;
						if (out.blocked) {
							blocked = out.blocked;
							break;
						}
					} else if (intake.state === "world_applied") {
						hook("world_applied", forgetId);
						const out = await memoryStep(intake);
						externals = out.externals ?? externals;
						if (out.blocked) throw new StepBlocked(out.blocked);
					} else {
						const reason = await reopenStep(intake);
						if (reason) {
							blocked = reason;
							break;
						}
						hook("complete", forgetId);
					}
				} catch (error) {
					const reason = transientReason(error);
					if (reason === null) throw error;
					blocked = reason;
					if (error instanceof WorldJournalCorruptError)
						options.gate?.close("JOURNAL_CORRUPT");
					try {
						await store.write((db) =>
							setBlockedReason(db, forgetId, reason, now()),
						);
					} catch {
						/* reported through the return value below */
					}
					break;
				}
			}
			return report(forgetId, { blocked, world, externals });
		});
	}

	// --- public: forget -----------------------------------------------------------

	async function acceptForget(
		request: ForgetRequest,
		settings: { advance?: boolean } = {},
	): Promise<ForgetReport | ForgetRefusal> {
		const accepted = await store.write((db) => acceptInWriter(db, request));
		if ("status" in accepted) return accepted;
		hook("accepted", accepted.forgetId);
		if (settings.advance === false) return report(accepted.forgetId);
		return advance(accepted.forgetId);
	}

	async function resumeForgets(
		filter?: (row: IntakeRow) => boolean,
	): Promise<ForgetReport[]> {
		const open = store.read((db) => listOpenIntakes(db));
		const reports: ForgetReport[] = [];
		for (const row of open) {
			if (filter && !filter(row)) continue;
			reports.push(await advance(row.forgetId));
		}
		return reports;
	}

	// --- restore ------------------------------------------------------------------

	type RegistrationStatus = "registered" | "unknown" | "tombstoned";
	const rank: Record<RegistrationStatus, number> = {
		registered: 0,
		unknown: 1,
		tombstoned: 2,
	};
	const better = (a: RegistrationStatus, b: RegistrationStatus) =>
		rank[a] >= rank[b] ? a : b;

	/** Memory's verdict for each dependency of each dependent, by re-registering through the public API. */
	function classify(
		db: Database,
		scope: ScopeRef,
		rows: readonly DependentRow[],
		epoch: string,
	): Map<string, RegistrationStatus> {
		const access = accessFor(db, scope);
		const status = new Map<string, RegistrationStatus>();
		const set = (key: string, next: RegistrationStatus) =>
			status.set(key, better(status.get(key) ?? "registered", next));
		for (const row of rows) {
			const dependsOn = row.dependsOn.map((d) => ({ type: d.type, id: d.id }));
			const result = memory.register(db, access, now(), scope.scopeKey, [
				{
					providerRef: "eumenes-world",
					externalId: row.externalId,
					dependsOn,
				},
			]);
			if (result.status === "registered") {
				for (const d of row.dependsOn) set(d.key, "registered");
				continue;
			}
			if (result.status === "blocked")
				throw new StepBlocked("MEMORY_UNAVAILABLE");
			if (result.reasonCode === "EXTERNAL_ID_IN_USE") {
				for (const d of row.dependsOn) set(d.key, "unknown");
				continue;
			}
			// Which dependency? Probe each alone with a throwaway dependent, removed again.
			for (const d of row.dependsOn) {
				const probeId = `w1p-${short(`${epoch}\u0000${d.type}\u0000${d.id}`)}-0`;
				const probe = memory.register(db, access, now(), scope.scopeKey, [
					{
						providerRef: "eumenes-world",
						externalId: probeId,
						dependsOn: [{ type: d.type, id: d.id }],
					},
				]);
				if (probe.status === "registered") {
					memory.unregister(db, access, now(), scope.scopeKey, [
						{ providerRef: "eumenes-world", externalId: probeId },
					]);
					set(d.key, "registered");
				} else if (
					probe.status === "rejected" &&
					probe.reasonCode === "TOMBSTONED"
				)
					set(d.key, "tombstoned");
				else if (probe.status === "blocked")
					throw new StepBlocked("MEMORY_UNAVAILABLE");
				else set(d.key, "unknown");
			}
		}
		return status;
	}

	function journalTombstones(
		entries: readonly WorldJournalEntry[],
		scope: ScopeRef,
	) {
		return entries
			.filter(
				(e) => e.principal === scope.principal && e.scopeKey === scope.scopeKey,
			)
			.flatMap((entry) =>
				entry.roots.filter(isValidRoot).map((root) => ({
					ref: { kind: root.kind, id: root.id, revision: root.revision },
					forgetId: entry.forgetId,
					reasonCode: entry.reasonCode,
				})),
			);
	}

	type RestoreOutcome = { ok: true } | { ok: false; reason: string };

	async function restoreScope(
		scope: ScopeRef,
		epoch: string,
		entries: readonly WorldJournalEntry[],
	): Promise<RestoreOutcome> {
		const tok = short(epoch);
		const mustApply = (
			result: WorldApplyResult,
			step: string,
		): string | null =>
			result.status === "applied" || result.status === "no_op"
				? null
				: `${step}_${why(result)}`;
		const begin = await store.write((db) =>
			mustApply(
				worldOp(db, scope, `rs:${tok}:begin`, { kind: "restore.begin" }),
				"BEGIN",
			),
		);
		if (begin) return { ok: false, reason: begin };
		hook("restore_begun");

		// Re-register every recorded World dependent through Memory, page by page.
		// What World was already told per key: a later page may only RAISE it
		// (registered -> unknown -> tombstoned), never be skipped.
		const told = new Map<string, RegistrationStatus>();
		let after: string | null = null;
		for (;;) {
			const page: { next: string | null; error: string | null } =
				await store.write((db) => {
					const rows = listDependents(
						db,
						scope.principal,
						scope.scopeKey,
						after,
						dependentPage,
					);
					if (rows.length === 0) return { next: null, error: null };
					const statuses = classify(db, scope, rows, epoch);
					const fresh = [...statuses].filter(([key, status]) => {
						const previous = told.get(key);
						return previous === undefined || rank[status] > rank[previous];
					});
					for (const group of chunk(fresh, MAX_REGISTRATIONS)) {
						const registrations = group.map(([sourceKey, status]) => ({
							sourceKey,
							status,
						}));
						const error = mustApply(
							worldOp(
								db,
								scope,
								`rs:${tok}:reg:${short(JSON.stringify(registrations))}`,
								{ kind: "restore.register", registrations },
							),
							"REGISTER",
						);
						if (error) throw new StepBlocked(error);
					}
					for (const [key, status] of fresh) told.set(key, status);
					return { next: rows[rows.length - 1]!.externalId, error: null };
				});
			if (page.next === null) break;
			after = page.next;
			hook("restore_registered");
		}

		// Re-apply the newest tombstones from the World journal, in pages.
		const tombstones = journalTombstones(entries, scope);
		const seq = entries[entries.length - 1]?.seq ?? 0;
		const pages =
			tombstones.length === 0 ? [[]] : chunk(tombstones, MAX_TOMBSTONES);
		for (const [index, page] of pages.entries()) {
			const journal = {
				seq,
				final: index === pages.length - 1,
				tombstones: page,
			};
			const error = await store.write((db) =>
				mustApply(
					worldOp(
						db,
						scope,
						`rs:${tok}:rec:${short(JSON.stringify(journal))}`,
						{ kind: "restore.reconcile", journal },
					),
					"RECONCILE",
				),
			);
			if (error) return { ok: false, reason: error };
		}
		hook("restore_reconciled");

		// Forgets of this Scope the restored database still owed: bring them through.
		await resumeForgets(
			(row) =>
				row.principal === scope.principal && row.scopeKey === scope.scopeKey,
		);

		hook("before_restore_finish");
		let drained = 0;
		for (let attempt = 0; attempt < 200; attempt++) {
			const finished = await store.write((db) =>
				worldOp(db, scope, `rs:${tok}:finish`, { kind: "restore.finish" }),
			);
			if (finished.status === "applied" || finished.status === "no_op") {
				hook("restore_finished");
				return { ok: true };
			}
			const pending =
				finished.status === "blocked" &&
				finished.restore?.pendingForget !== undefined
					? finished.restore.pendingForget
					: -1;
			if (
				finished.status === "blocked" &&
				(finished.reasonCode === "FORGET_PENDING" ||
					finished.reasonCode === "JOURNAL_NOT_RECONCILED") &&
				drained < 100
			) {
				// A derived forget drains one chunk per register/reconcile call.
				drained += 1;
				const journal = { seq, final: true, tombstones: [] as never[] };
				const error = await store.write((db) =>
					mustApply(
						worldOp(db, scope, `rs:${tok}:drain:${drained}`, {
							kind: "restore.reconcile",
							journal,
						}),
						"DRAIN",
					),
				);
				if (error) return { ok: false, reason: error };
				void pending;
				continue;
			}
			if (
				finished.status === "blocked" &&
				finished.reasonCode === "FORGET_AWAITING_CONFIRMATION" &&
				attempt < 3
			) {
				await resumeForgets(
					(row) =>
						row.principal === scope.principal &&
						row.scopeKey === scope.scopeKey,
				);
				continue;
			}
			return { ok: false, reason: `FINISH_${why(finished)}` };
		}
		return { ok: false, reason: "FINISH_NOT_CONVERGING" };
	}

	/** Intakes for journal entries a restored database never saw; their World content went through derived forgets. */
	async function adoptJournalEntries(entries: readonly WorldJournalEntry[]) {
		await store.write((db) => {
			const known = allIntakeIds(db);
			for (const entry of entries) {
				if (known.has(entry.forgetId)) continue;
				insertIntake(
					db,
					{
						forgetId: entry.forgetId,
						principal: entry.principal,
						scopeKey: entry.scopeKey,
						memoryForgetId: entry.memoryForgetId,
						memoryFinal: true,
						reasonCode: entry.reasonCode,
						origin: "restored",
						roots: entry.roots.filter(isValidRoot),
						rootsDigest: rootDigest(entry.roots.filter(isValidRoot)),
						state: "world_applied",
						journalSeq: entry.seq,
						journalHash: entry.hash,
					},
					now(),
				);
			}
		});
	}

	/**
	 * After a restore every completed Memory-linked forget is checked again
	 * against Memory's own receipt. A forget stays `complete` only when that
	 * check succeeded and shows every external confirmed (after confirming what
	 * is verifiably gone from World). Anything else - Memory still showing
	 * pending externals the roots do not reach, or a check that hit a transient
	 * error - moves the intake back to `world_applied` (World content stays
	 * deleted), so resume re-confirms it and recoverWorld reports it. Returns
	 * those forgets: the caller keeps the gate CLOSED for them (fail closed).
	 */
	async function reverifyMemory(): Promise<
		{ forgetId: string; reason: string }[]
	> {
		const linked = store.read((db) => listMemoryLinkedIntakes(db));
		const unresolved: { forgetId: string; reason: string }[] = [];
		for (const row of linked) {
			if (row.state !== "complete") continue;
			await withLock(row.forgetId, async () => {
				const regress = async (reason: string) => {
					try {
						await store.write((db) =>
							reopenIntakeForMemory(db, row.forgetId, reason, now()),
						);
					} catch {
						/* the in-memory report below still keeps the gate closed */
					}
					unresolved.push({ forgetId: row.forgetId, reason });
				};
				try {
					const outcome = await store.write((db) => {
						const current = getIntake(db, row.forgetId);
						if (!current || current.memoryForgetId === null) return null;
						const synced = syncConfirmations(db, current);
						const access = accessFor(db, scopeOf(current));
						for (const externalId of synced.confirmable) {
							const result = memory.record(db, access, now(), {
								forgetId: current.memoryForgetId,
								externalId,
								state: "confirmed",
							});
							if (result !== "recorded")
								throw new StepBlocked(`MEMORY_${result.toUpperCase()}`);
							upsertConfirmation(
								db,
								current.memoryForgetId,
								externalId,
								"confirmed",
								now(),
							);
						}
						if (synced.uncovered.length > 0) {
							reopenIntakeForMemory(
								db,
								current.forgetId,
								"MEMORY_EXTERNAL_NOT_COVERED",
								now(),
							);
							return "MEMORY_EXTERNAL_NOT_COVERED";
						}
						return null;
					});
					if (outcome !== null)
						unresolved.push({ forgetId: row.forgetId, reason: outcome });
				} catch (error) {
					const reason = transientReason(error);
					if (reason === null) throw error;
					await regress(reason);
				}
			});
		}
		return unresolved;
	}

	type Decision =
		| { kind: "closed"; reason: string }
		| {
				kind: "ok";
				restore: boolean;
				epoch: string | null;
				scopes: ScopeRef[];
		  };

	function decide(
		entries: readonly WorldJournalEntry[],
		db: Database,
		request: { restore: boolean; reason: string | null },
	): Decision {
		// The database may only reference journal entries that exist, unchanged.
		for (const row of intakesWithJournal(db)) {
			const entry = entries[row.journalSeq! - 1];
			if (!entry) return { kind: "closed", reason: "JOURNAL_TRUNCATED" };
			if (entry.hash !== row.journalHash || entry.forgetId !== row.forgetId)
				return { kind: "closed", reason: "JOURNAL_MISMATCH" };
		}
		const known = allIntakeIds(db);
		const missing = entries.filter((e) => !known.has(e.forgetId));
		const running = readRestore(db);
		const restore =
			request.restore || missing.length > 0 || running?.state === "in_progress";
		const scopes = new Map<string, ScopeRef>();
		for (const scope of [
			...listKnownScopes(db).map((s) => ({
				principal: s.principal,
				scopeKey: s.scopeKey,
			})),
			...(options.scopes ?? []),
			...entries.map((e) => ({ principal: e.principal, scopeKey: e.scopeKey })),
		])
			scopes.set(JSON.stringify([scope.principal, scope.scopeKey]), scope);
		return {
			kind: "ok",
			restore,
			epoch: running?.state === "in_progress" ? running.restoreEpoch : null,
			scopes: [...scopes.values()],
		};
	}

	// recoverWorld() calls are serialised: a second call waits for the first, and
	// only the LAST one outstanding may open the gate, so a call that finishes
	// early can never reopen it in the middle of another call's restore.
	let recoveries = 0;
	let recoverTail: Promise<unknown> = Promise.resolve();

	/**
	 * Startup gate. Call before the queue starts. It verifies the World journal
	 * against the database, detects a restored (older) database, runs the whole
	 * restore when needed, resumes every forget that has not yet deleted its
	 * World content, and only then opens the host gate. Any failure leaves the
	 * gate closed (fail closed) and says why.
	 */
	async function runRecover(
		request: {
			/** A database restore is known (operator action). */
			restored?: boolean;
			/** Memory's recover() reported feedResyncRequired. */
			memoryFeedResyncRequired?: boolean;
		} = {},
	): Promise<RecoverReport> {
		const closed = (reason: string): RecoverReport => {
			options.gate?.close(reason);
			return { status: "closed", reason };
		};
		try {
			let entries: WorldJournalEntry[];
			try {
				entries = readWorldJournal(options.journalPath);
			} catch (error) {
				if (error instanceof WorldJournalCorruptError)
					return closed(`JOURNAL_${error.code.toUpperCase()}`);
				throw error;
			}
			const requested =
				request.restored === true || request.memoryFeedResyncRequired === true;
			const decision = await store.write((db) =>
				decide(entries, db, {
					restore: requested,
					reason: request.restored
						? "OPERATOR_RESTORE"
						: request.memoryFeedResyncRequired
							? "MEMORY_FEED_RESYNC"
							: null,
				}),
			);
			if (decision.kind === "closed") return closed(decision.reason);
			let restored = false;
			if (decision.restore) {
				restored = true;
				// A new epoch only when no restore is already running (resume otherwise).
				const epoch =
					decision.epoch ??
					(await store.write((db) => {
						const token = world.bumpRestoreEpochInWriter(db);
						dropFeedCursors(db);
						// World deletes the unsettled inbox events at restore.begin.
						purgeUnsettledExtractEvents(db);
						writeRestore(
							db,
							token,
							"in_progress",
							request.restored ? "OPERATOR_RESTORE" : "JOURNAL_AHEAD",
							now(),
						);
						return token;
					}));
				for (const scope of decision.scopes) {
					const outcome = await restoreScope(scope, epoch, entries);
					if (!outcome.ok) return closed(`RESTORE_${outcome.reason}`);
				}
				await adoptJournalEntries(entries);
				await store.write((db) =>
					writeRestore(db, epoch, "complete", null, now()),
				);
			}
			// World content of every accepted forget must be gone before the gate opens.
			const reports = await resumeForgets();
			const stuck = reports.filter(
				(r) => r.state === "pending" || r.state === "journaled",
			);
			if (stuck.length > 0)
				return closed(
					`FORGET_PENDING:${stuck[0]!.blocked ?? stuck[0]!.state.toUpperCase()}:${stuck.length}`,
				);
			// Fail closed: after a restore, a forget whose Memory confirmations cannot
			// be shown as complete (or checked at all) keeps the gate shut, even
			// though its World content is already deleted. The next recoverWorld()
			// without a restore finishes the confirmations and opens it.
			if (restored) {
				const unverified = await reverifyMemory();
				if (unverified.length > 0)
					return closed(
						`MEMORY_UNVERIFIED:${unverified[0]!.reason}:${unverified.length}`,
					);
			}
			// A concurrent recoverWorld() started meanwhile owns the final decision.
			if (recoveries === 1) options.gate?.open();
			const left = store.read((db) => ({
				pending: listOpenIntakes(db).map((row) => row.forgetId),
				abandoned: listAbandonedForgetIds(db),
			}));
			return {
				status: "open",
				restored,
				pendingForgets: left.pending,
				abandonedForgets: left.abandoned,
			};
		} catch (error) {
			const reason = transientReason(error);
			if (reason === null) {
				options.gate?.close("RECOVERY_FAILED");
				throw error;
			}
			return closed(reason);
		}
	}

	function recoverWorld(
		request: {
			/** A database restore is known (operator action). */
			restored?: boolean;
			/** Memory's recover() reported feedResyncRequired. */
			memoryFeedResyncRequired?: boolean;
		} = {},
	): Promise<RecoverReport> {
		recoveries += 1;
		// Closed from the moment the call is made, also while it waits its turn.
		options.gate?.close("RECOVERY_REQUIRED");
		const run = recoverTail.then(
			() => runRecover(request),
			() => runRecover(request),
		);
		const done = run.then(
			() => undefined,
			() => undefined,
		);
		recoverTail = done;
		return run.finally(() => {
			recoveries -= 1;
		});
	}

	// --- change feeds -------------------------------------------------------------

	/** A Memory forget id may not contain the reserved part separator: such ids are hashed. */
	const feedForgetId = (id: string): string =>
		validForgetId(id, false) ? id : `mf-${short(id)}`;

	function feedKeyOf(scope: ScopeRef, a: string | number, b: string | number) {
		return short(
			`${scope.principal}\u0000${scope.scopeKey}\u0000${a}\u0000${b}`,
		);
	}

	/** Roots of a Memory notification that says "forgotten". */
	function memoryRoot(change: {
		targetType: string;
		targetId: string;
	}): ForgetRoot | null {
		if (change.targetType === "source")
			return { kind: "source", id: change.targetId, revision: 1 };
		if (change.targetType === "state_item")
			return { kind: "state", id: stateItemKey(change.targetId), revision: 1 };
		if (change.targetType === "record")
			return { kind: "source", id: recordKey(change.targetId), revision: 1 };
		return null;
	}

	const STOPPED = new Set([
		"inactive",
		"superseded",
		"disputed",
		"retracted",
		"invalidated",
	]);

	/** Stops (never deletes) the assertions that stand on these source keys. */
	function invalidateKeys(
		db: Database,
		scope: ScopeRef,
		label: string,
		keys: readonly string[],
	): number {
		let count = 0;
		for (const [index, group] of chunk(
			[...new Set(keys)],
			INVALIDATE_KEYS,
		).entries()) {
			const result = worldOp(
				db,
				scope,
				`fd:${feedKeyOf(scope, label, index)}:${short(JSON.stringify(group))}`,
				{
					kind: "invalidate",
					reasonCode: "INPUT_VERSION_INVALIDATED",
					targets: [],
					sourceKeys: group,
				},
			);
			if (result.status !== "applied" && result.status !== "no_op")
				throw new StepBlocked(`WORLD_${why(result)}`);
			count += group.length;
		}
		return count;
	}

	/** Whether this writer callback may hand extraction input to World (decided once per page). */
	function receiveUsable(
		db: Database,
	): { ok: true } | { ok: false; reason: "WORLD_OFF" | "GATE_CLOSED" } {
		if (options.gate && !options.gate.isOpen())
			return { ok: false, reason: "GATE_CLOSED" };
		return world.statusInTransaction(db).usable
			? { ok: true }
			: { ok: false, reason: "WORLD_OFF" };
	}

	/**
	 * Where each feed stands, stage by stage: the owner (is there more at the
	 * source?), the host's scan position, what World's inbox took, and what was
	 * semantically settled. Unsettled events are never reported as applied; the
	 * applied cursor stops before the oldest unsettled event.
	 */
	function feedStages(
		scope: ScopeRef,
		settings: { namespace?: string } = {},
	): FeedStages {
		const adapter = adapters.get(settings.namespace ?? "conversation");
		return store.read((db) => {
			let sourceAhead: boolean | "unknown" = "unknown";
			if (adapter) {
				const cursor = world.feedCursor(db, "source", scope);
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				try {
					const head = adapter.listChanges(db, accessFor(db, scope), {
						cursor: scopeSetChanged(db, "source", scope, scopeKeys)
							? null
							: cursor.cursor,
						limit: 1,
					});
					sourceAhead = head.changes.length > 0 || head.hasMore;
				} catch {
					sourceAhead = "unknown";
				}
			}
			let memoryAhead: boolean | "unknown" = "unknown";
			const memoryCursor = world.feedCursor(db, "memory", scope);
			const memoryKeys = scopeSetOf(options.scopes ?? [], scope);
			const after = scopeSetChanged(db, "memory", scope, memoryKeys)
				? 0
				: memoryCursor.cursor === null
					? 0
					: Number(memoryCursor.cursor);
			if (Number.isSafeInteger(after) && after >= 0) {
				try {
					const page = memory.listChanges(db, accessFor(db, scope), {
						scopeKey: scope.scopeKey,
						afterSeq: after,
						limit: 1,
					});
					if (page.status === "ok")
						memoryAhead = page.changes.length > 0 || page.hasMore;
				} catch {
					memoryAhead = "unknown";
				}
			}
			return {
				source: sourceFeedStages(db, scope, sourceAhead),
				memory: memoryFeedStages(db, scope, memoryAhead),
			};
		});
	}

	/**
	 * Reads Memory's change feed from the persisted cursor (valid only for the
	 * current restore epoch; a stale cursor re-reads everything). In ONE writer
	 * callback: "forgotten" notifications become durable forget intakes,
	 * other status changes invalidate World items, and the cursor moves.
	 * Forgets are then driven to completion (World deletion needs no model,
	 * no World ON and no Memory).
	 */
	async function consumeMemoryChanges(
		scope: ScopeRef,
		settings: { limit?: number } = {},
	): Promise<ConsumeReport> {
		const limit = Math.min(settings.limit ?? FEED_PAGE, FEED_PAGE);
		let out: {
			resync: boolean;
			changes: number;
			intakes: string[];
			invalidated: number;
			hasMore: boolean;
			rejectedRoots: number;
		};
		try {
			out = await store.write((db) => {
				const cursor = world.feedCursor(db, "memory", scope);
				// A different Scope set discards the cursor: the feed is read again.
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				const widened = scopeSetChanged(db, "memory", scope, scopeKeys);
				const afterSeq =
					widened || cursor.cursor === null ? 0 : Number(cursor.cursor);
				if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
					throw new StepBlocked("FEED_CURSOR_INVALID");
				const access = accessFor(db, scope);
				const rows: MemoryChange[] = [];
				let position = afterSeq;
				let hasMore = false;
				let cut = false;
				for (let first = true; ; first = false) {
					const page = memory.listChanges(db, access, {
						scopeKey: scope.scopeKey,
						afterSeq: position,
						limit: first ? limit : FEED_PAGE,
					});
					if (page.status !== "ok")
						throw new StepBlocked("MEMORY_FEED_BLOCKED");
					let taken = [...page.changes];
					let next = page.nextAfterSeq;
					hasMore = page.hasMore;
					let split = -1;
					if (!first) {
						// Only the forget run the previous page ended in continues here.
						const run = rows[rows.length - 1]!.forgetId;
						split = taken.findIndex((c) => c.forgetId !== run);
						if (split >= 0) {
							taken = taken.slice(0, split);
							next =
								taken.length === 0 ? position : taken[taken.length - 1]!.seq;
							hasMore = true;
						}
					}
					rows.push(...taken);
					position = next;
					if (split >= 0) break;
					const last = rows[rows.length - 1];
					if (!hasMore || last === undefined || last.forgetId === null) break;
					if (rows.length >= FEED_MAX_ROWS) {
						cut = true;
						break;
					}
				}
				// Forgets: one intake per Memory forgetId in this batch.
				const groups = new Map<string, ForgetRoot[]>();
				const lastStatus = new Map<string, { status: string; key: string }>();
				for (const change of rows) {
					if (change.status === "forgotten") {
						const root = memoryRoot(change);
						if (root === null) continue;
						const id = change.forgetId ?? `unnamed-${rows[0]!.seq}`;
						const list = groups.get(id) ?? [];
						list.push(root);
						groups.set(id, list);
					} else if (change.targetType !== "source") {
						const key =
							change.targetType === "state_item"
								? stateItemKey(change.targetId)
								: recordKey(change.targetId);
						lastStatus.set(`${change.targetType}:${change.targetId}`, {
							status: change.status,
							key,
						});
					}
				}
				const firstSeq = rows[0]?.seq ?? 0;
				const lastForget = rows[rows.length - 1]?.forgetId ?? null;
				const intakes: string[] = [];
				let rejectedRoots = 0;
				for (const [memoryForgetId, allRoots] of groups) {
					// Ids World would refuse are counted and skipped; they must not
					// keep the cursor (and every other root) from moving.
					const split = splitValidRoots(allRoots);
					rejectedRoots += split.rejected;
					if (split.valid.length === 0) continue;
					// Deduplicated first: both sides of the digest comparison are the
					// stored (deduplicated) form.
					const roots = normalizeRoots(split.valid);
					if ("status" in roots)
						throw new StepBlocked(`INTAKE_${roots.reasonCode}`);
					const final = !(cut && memoryForgetId === lastForget);
					let forgetId = feedForgetId(memoryForgetId);
					const existing = getIntake(db, forgetId);
					if (
						existing &&
						existing.rootsDigest !== rootDigest(roots) &&
						!rootsCover(existing, roots)
					)
						forgetId = feedForgetId(`${memoryForgetId}#${firstSeq}`);
					const accepted = acceptInWriter(
						db,
						{
							forgetId,
							scope,
							reasonCode: "SOURCE_FORGOTTEN",
							roots,
							memoryForgetId,
							origin: "memory_feed",
						},
						{ memoryFinal: final },
					);
					if ("status" in accepted)
						throw new StepBlocked(`INTAKE_${accepted.reasonCode}`);
					intakes.push(forgetId);
				}
				const stopped = [...lastStatus.values()]
					.filter((v) => STOPPED.has(v.status))
					.map((v) => v.key);
				const invalidated =
					stopped.length === 0
						? 0
						: invalidateKeys(db, scope, `mem:${firstSeq}:${position}`, stopped);
				world.saveFeedCursorInWriter(db, "memory", scope, String(position));
				writeExtractFeedScopeSet(
					db,
					"memory",
					scope.principal,
					scope.scopeKey,
					JSON.stringify(scopeKeys),
				);
				hook("feed_cursor_saved");
				return {
					resync: cursor.stale || widened,
					changes: rows.length,
					intakes,
					invalidated,
					hasMore,
					rejectedRoots,
				};
			});
		} catch (error) {
			const reason = transientReason(error);
			if (reason === null) throw error;
			return {
				resync: false,
				changes: 0,
				forgets: [],
				invalidated: 0,
				hasMore: false,
				blocked: reason,
				rejectedRoots: 0,
			};
		}
		const forgets: ForgetReport[] = [];
		for (const id of out.intakes) forgets.push(await advance(id));
		return {
			resync: out.resync,
			changes: out.changes,
			forgets,
			invalidated: out.invalidated,
			hasMore: out.hasMore,
			blocked: null,
			rejectedRoots: out.rejectedRoots,
		};
	}

	/**
	 * Reads the conversation outbox (SourceAdapter.listChanges) from its own
	 * persisted cursor. Deletions and retractions are applied before additions
	 * and corrections (deletionsFirst): a retraction becomes a forget intake, a
	 * correction stops the assertions that stand on the old version, and every
	 * remaining user addition or correction is handed to World's inbox
	 * (`inbox.receive`, P4-01) once those two are applied. The receipts and the
	 * cursor move in the same writer callback; the semantic application
	 * (extraction, `candidate.settle`) is a separate, later step.
	 */
	async function consumeSourceChanges(
		scope: ScopeRef,
		settings: { namespace?: string; limit?: number } = {},
	): Promise<ConsumeReport> {
		const adapter = adapters.get(settings.namespace ?? "conversation");
		if (!adapter)
			return {
				resync: false,
				changes: 0,
				forgets: [],
				invalidated: 0,
				hasMore: false,
				blocked: "SOURCE_ADAPTER_MISSING",
				rejectedRoots: 0,
			};
		let out: {
			resync: boolean;
			changes: number;
			intakes: string[];
			invalidated: number;
			hasMore: boolean;
			rejectedRoots: number;
			received: number;
			skipped: number;
		};
		try {
			out = await store.write((db) => {
				const cursor = world.feedCursor(db, "source", scope);
				// A different Scope set discards the cursor: the feed is read again.
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				const widened = scopeSetChanged(db, "source", scope, scopeKeys);
				const access = accessFor(db, scope);
				const page = adapter.listChanges(db, access, {
					cursor: widened ? null : cursor.cursor,
					limit: Math.min(settings.limit ?? FEED_PAGE, FEED_PAGE),
				});
				const ordered = deletionsFirst(
					page.changes.filter(
						(c) =>
							c.principal === scope.principal && c.scopeKey === scope.scopeKey,
					),
				);
				const intakes: string[] = [];
				const retracted = ordered.filter((c) => c.kind === "retracted");
				const split = splitValidRoots(
					retracted.map((c) => ({
						kind: "source" as const,
						id: sourceKeyOf(c.source),
						revision: 1,
					})),
				);
				if (split.valid.length > 0) {
					const forgetId = `sf-${feedKeyOf(scope, "source", page.nextCursor)}`;
					const accepted = acceptInWriter(db, {
						forgetId,
						scope,
						reasonCode: "SOURCE_FORGOTTEN",
						roots: split.valid,
						origin: "source_feed",
					});
					if ("status" in accepted)
						throw new StepBlocked(`INTAKE_${accepted.reasonCode}`);
					intakes.push(forgetId);
				}
				const corrected = ordered
					.filter((c) => c.kind === "corrected")
					.map((c) => sourceKeyOf(c.source));
				const invalidated =
					corrected.length === 0
						? 0
						: invalidateKeys(db, scope, `src:${page.nextCursor}`, corrected);
				// Corrections and forgets above come first; only then are the
				// remaining additions persisted as extraction input (P4-01). The
				// receipt and the cursor save are ONE writer callback: if it fails
				// (database, Writer) nothing of it remains and the cursor stays.
				const state = receiveUsable(db);
				const receipt = receiveSourceChanges(
					db,
					{ worldOp, usable: () => state, now },
					scope,
					{ scopeKeys, restoreEpoch: cursor.restoreEpoch },
					ordered,
				);
				world.saveFeedCursorInWriter(db, "source", scope, page.nextCursor);
				writeExtractFeedScopeSet(
					db,
					"source",
					scope.principal,
					scope.scopeKey,
					JSON.stringify(scopeKeys),
				);
				hook("feed_cursor_saved");
				return {
					resync: cursor.stale || widened,
					changes: page.changes.length,
					intakes,
					invalidated,
					hasMore: page.hasMore,
					rejectedRoots: split.rejected,
					received: receipt.received,
					skipped: receipt.skipped,
				};
			});
		} catch (error) {
			const reason = transientReason(error);
			if (reason === null) throw error;
			return {
				resync: false,
				changes: 0,
				forgets: [],
				invalidated: 0,
				hasMore: false,
				blocked: reason,
				rejectedRoots: 0,
			};
		}
		const forgets: ForgetReport[] = [];
		for (const id of out.intakes) forgets.push(await advance(id));
		return {
			resync: out.resync,
			changes: out.changes,
			forgets,
			invalidated: out.invalidated,
			hasMore: out.hasMore,
			blocked: null,
			rejectedRoots: out.rejectedRoots,
			received: out.received,
			skippedInputs: out.skipped,
		};
	}

	return {
		/** Durable intake, then World journal, World forget, Memory confirmation, reopen. */
		acceptForget,
		/** Resume one forget from wherever it stopped. */
		resumeForget: advance,
		/** Resume every forget that is not complete (also done by recoverWorld). */
		resumeForgets,
		forgetStatus: (forgetId: string): ForgetReport | null =>
			store.read((db) => {
				const row = getIntake(db, forgetId);
				return row ? reportOf(db, row) : null;
			}),
		recoverWorld,
		/**
		 * Retry sweep for Memory dependents whose unregistration was refused
		 * (host rows marked release_pending). Idempotent, never throws on Memory.
		 */
		sweepPendingReleases: (limit = 200) =>
			store.write((db) =>
				sweepReleasePending(db, limit, (scope) => unregisterFor(db, scope)),
			),
		/** Explicit restore: same procedure as a detected one. */
		startRestore: () => recoverWorld({ restored: true }),
		consumeMemoryChanges,
		consumeSourceChanges,
		/** Each checkpoint stage of both feeds (owner, scanned, received, applied). */
		feedStages,
	};
}
export type WorldLifecycle = ReturnType<typeof createWorldLifecycle>;
