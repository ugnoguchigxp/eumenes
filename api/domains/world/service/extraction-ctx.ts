import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type ScopeRef } from "eumenes-world-model";
import { WORLD_PROVIDER_REF } from "../contracts";
import { releaseExtractJob } from "../repository/extraction";
import {
	deleteDependents,
	listDependentIdsByPrefix,
	markReleasePending,
} from "../repository/usage";
import { defaultMemoryPort, type MemoryPort } from "./lifecycle-memory";
import { externalIdOf } from "./memory-adapter";
import {
	type ExtractionPoint,
	type ExtractionOptions,
} from "./extraction-types";
import {
	WORLD_EXTRACT_PURPOSE,
	EXTRACT_STAGE_BUDGET_MS,
	EXTRACT_CONFIRM_MS,
	BACKOFF_BASE_MS,
	BACKOFF_MAX_MS,
	EXTRACT_INTERPRETATION_VERSION,
	defaultHasher,
} from "./extraction-shared";

/** Configuration and the pieces every part of the extraction handler shares. */
export function createExtractionCtx(options: ExtractionOptions) {
	const { store, world, inference, queue } = options;
	const purpose = options.purpose ?? WORLD_EXTRACT_PURPOSE;
	const now = options.clock ?? (() => Date.now());
	const newId = options.id ?? (() => randomUUID());
	const hasher = options.hasher ?? defaultHasher;
	const memory: MemoryPort = { ...defaultMemoryPort, ...options.memory };
	const budgetMs = options.stageBudgetMs ?? EXTRACT_STAGE_BUDGET_MS;
	const confirmMs = options.confirmMs ?? EXTRACT_CONFIRM_MS;
	const interpretationVersion =
		options.interpretationVersion ?? EXTRACT_INTERPRETATION_VERSION;
	const adapters = new Map(options.sources.map((s) => [s.namespace, s]));
	const hook = (point: ExtractionPoint, jobId: string) =>
		options.hook?.(point, { jobId });
	const foregroundActive = (): boolean => {
		try {
			return options.foreground?.active() === true;
		} catch {
			// An unreadable foreground is treated as busy: background work yields.
			return true;
		}
	};
	/** Listeners told when the provider call that held the Local slot finally ended. */
	const slotListeners = new Set<() => void>();
	/** The model call that still holds the Local slot (shared by schedule, prepare and execute). */
	const slot: { inFlight: Promise<unknown> | null } = { inFlight: null };

	const accessOf = (db: Database, scope: ScopeRef) =>
		world.accessInTransaction(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
		});

	function usable(db: Database): string | null {
		if (options.gate && !options.gate.isOpen()) return "world_gate_closed";
		return world.statusInTransaction(db).usable ? null : "world_disabled";
	}

	// --- Memory dependents ------------------------------------------------------

	const manifestPrefix = (scope: ScopeRef, manifestId: string) => {
		const first = externalIdOf(
			"m",
			scope.principal,
			scope.scopeKey,
			[manifestId],
			0,
		);
		return first.slice(0, first.lastIndexOf("-") + 1);
	};

	/** Gives the pre-registered dependents back; a refusal keeps the host rows for the sweep. */
	function releaseManifests(
		db: Database,
		scope: ScopeRef,
		manifestIds: readonly string[],
	): void {
		const ids = manifestIds.flatMap((id) =>
			listDependentIdsByPrefix(
				db,
				scope.principal,
				scope.scopeKey,
				manifestPrefix(scope, id),
			),
		);
		if (ids.length === 0) return;
		const savepoint = "world_extract_release";
		let released = false;
		db.exec(`SAVEPOINT ${savepoint}`);
		try {
			released =
				memory.unregister(
					db,
					accessOf(db, scope),
					now(),
					scope.scopeKey,
					ids.map((externalId) => ({
						providerRef: WORLD_PROVIDER_REF,
						externalId,
					})),
				) === "unregistered";
			db.exec(`RELEASE ${savepoint}`);
		} catch {
			db.exec(`ROLLBACK TO ${savepoint}`);
			db.exec(`RELEASE ${savepoint}`);
		}
		if (released) deleteDependents(db, scope.principal, scope.scopeKey, ids);
		else markReleasePending(db, scope.principal, scope.scopeKey, ids);
	}

	/** Back to the pool; the pre-registered dependents and the model request are withdrawn. */
	function endJob(
		db: Database,
		scope: ScopeRef,
		jobId: string,
		failure: boolean,
	): void {
		const rows = releaseExtractJob(
			db,
			jobId,
			failure
				? { nowMs: now(), baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS }
				: null,
		);
		releaseManifests(
			db,
			scope,
			rows.flatMap((r) => (r.manifestId ? [r.manifestId] : [])),
		);
		const requests = rows.flatMap((r) => (r.requestId ? [r.requestId] : []));
		if (requests.length > 0)
			inference.cancelRequestsInTransaction(db, [...new Set(requests)]);
	}
	return {
		options,
		store,
		world,
		inference,
		queue,
		purpose,
		now,
		newId,
		hasher,
		memory,
		budgetMs,
		confirmMs,
		interpretationVersion,
		adapters,
		hook,
		foregroundActive,
		slotListeners,
		slot,
		accessOf,
		usable,
		manifestPrefix,
		releaseManifests,
		endJob,
	};
}
export type ExtractionCtx = ReturnType<typeof createExtractionCtx>;
