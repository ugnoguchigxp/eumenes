import type { Database } from "bun:sqlite";
import { type AccessContext } from "eumenes-memory";
import { type ScopeRef } from "eumenes-world-model";
import {
	WORLD_PROVIDER_REF,
	type WorldApplyRequest,
	type WorldApplyResult,
} from "../contracts";
import {
	getIntake,
	insertIntake,
	TOMBSTONE_REASONS,
	type ForgetRoot,
	type IntakeRow,
} from "../repository/lifecycle";
import { listAbandoned } from "../repository/guard";
import {
	purgeRuntimeObservations,
	runtimeOutcomeRootsOfSources,
} from "../repository/runtime";
import { candidateRootsFor, purgeForgotten } from "./extraction-intake";
import { defaultMemoryPort, type MemoryPort } from "./lifecycle-memory";
import { forgetUsageInScope, type UnregisterDependents } from "./usage-ledger";
import type {
	LifecyclePoint,
	LifecycleOptions,
	ForgetRequest,
	ForgetReport,
	ForgetRefusal,
} from "./lifecycle-types";
import {
	DEFAULT_DEPENDENT_PAGE,
	rootDigest,
	rootsCover,
	validForgetId,
	normalizeRoots,
} from "./lifecycle-shared";

/**
 * Shared state of one lifecycle: options, clock, the Memory port, the
 * per-forgetId lock, the World call wrapper and the intake (accept) step that
 * the forget, restore and feed parts all build on.
 */
export function createLifecycleCtx(options: LifecycleOptions) {
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

	return {
		options,
		store,
		world,
		now,
		memory,
		maxChunks,
		confirmBatch,
		dependentPage,
		hook,
		adapters,
		withLock,
		accessFor,
		unregisterFor,
		worldOp,
		acceptInWriter,
		reportOf,
		report,
	};
}
export type LifecycleCtx = ReturnType<typeof createLifecycleCtx>;
