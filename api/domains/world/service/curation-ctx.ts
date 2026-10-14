import type { Database } from "bun:sqlite";
import type { SourceRef, SourceState } from "eumenes-memory";
import { extractionLimits, type ScopeRef } from "eumenes-world-model";
import { sha256Hex } from "../../../infrastructure/digest";
import { WORLD_PROVIDER_REF, type SourceKey } from "../contracts";
import {
	getExtractEvent,
	listExtractEventsByIds,
	setExtractManifest,
	settleExtractEvent,
	type ExtractEventRow,
} from "../repository/extraction";
import {
	deleteDependents,
	listDependentIdsByPrefix,
	markReleasePending,
} from "../repository/usage";
import { createReads } from "./curation-reads";
import { externalIdOf } from "./memory-adapter";
import { defaultMemoryPort, type MemoryPort } from "./lifecycle-memory";
import type { CurationOptions } from "./curation-types";

/** AccessContext.purpose of curation reads and writes (the source adapters must allow it). */
export const WORLD_CURATE_PURPOSE = "world.curate";
/** Evidence older than this is `stale` (freshness policy of a curated claim). */
export const FRESHNESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CURATION_INTERPRETATION_VERSION = "curate-v1";
/** Most entities the Scope digest and a candidate lookup read at once (the package's list limit). */
export const LIST_LIMIT = 500;
/** One id list per `listEntities` call (the package's limit). */
export const IDS_PER_CALL = 500;

export const short = (text: string) => sha256Hex(text).slice(0, 24);
export const utf8Length = (text: string) =>
	new TextEncoder().encode(text).length;

/** A failure that must roll back the caller's transaction. */
export class CurationError extends Error {
	constructor(readonly code: string) {
		super(`world_curation_${code}`);
	}
}

export type Live = {
	event: ExtractEventRow;
	ref: SourceRef;
	state: SourceState;
	text: string;
};
export type Classified =
	| { kind: "live"; live: Live }
	| { kind: "final"; reason: string };

/** Configuration and the pieces every part of curation shares. */
export function createCurationCtx(options: CurationOptions) {
	const { world, lifecycle, intake } = options;
	const purpose = options.purpose ?? WORLD_CURATE_PURPOSE;
	const now = options.clock ?? (() => Date.now());
	const hasher = options.hasher ?? ((bytes) => sha256Hex(bytes));
	const memory: MemoryPort = { ...defaultMemoryPort, ...options.memory };
	const interpretationVersion =
		options.interpretationVersion ?? CURATION_INTERPRETATION_VERSION;
	const adapters = new Map(options.sources.map((s) => [s.namespace, s]));

	const accessOf = (db: Database, scope: ScopeRef) =>
		world.accessInTransaction(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
		});

	/** Why World can not be used right now, or null. */
	function unusable(db: Database): string | null {
		if (options.gate && !options.gate.isOpen()) return "world_unavailable";
		return world.statusInTransaction(db).usable ? null : "world_unavailable";
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
		const savepoint = "world_curation_release";
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

	/** Releases what these events pre-registered at prepare and forgets that they did. */
	function releaseEvents(
		db: Database,
		scope: ScopeRef,
		eventIds: readonly string[],
	): void {
		const rows = listExtractEventsByIds(
			db,
			scope.principal,
			scope.scopeKey,
			eventIds,
		).filter((row) => row.state === "received" && row.manifestId !== null);
		if (rows.length === 0) return;
		releaseManifests(
			db,
			scope,
			rows.map((row) => row.manifestId as string),
		);
		for (const row of rows)
			setExtractManifest(
				db,
				scope.principal,
				scope.scopeKey,
				row.eventId,
				null,
			);
	}

	// --- World settle -----------------------------------------------------------

	function settleOp(
		db: Database,
		scope: ScopeRef,
		event: ExtractEventRow,
		operation: Record<string, unknown>,
	) {
		const result = world.applyInWriter(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
			scope,
			operationKey: `xs-${event.eventId}`,
			clock: now(),
			operation: {
				kind: "candidate.settle",
				feed: {
					scopeKeys: event.feedScopeKeys,
					kind: "source",
					cursorRestoreEpoch: event.feedRestoreEpoch,
				},
				eventId: event.eventId,
				...operation,
			} as never,
		});
		if (result.status !== "applied" && result.status !== "no_op")
			throw new CurationError(
				`settle_refused_${"reasonCode" in result ? result.reasonCode : result.status}`,
			);
	}

	/** Settles one event as rejected (final) in World and in the host record. */
	function rejectEvent(
		db: Database,
		scope: ScopeRef,
		event: ExtractEventRow,
		reason: string,
	): void {
		settleOp(db, scope, event, {
			disposition: "rejected",
			assertions: [],
			appliedCursor: event.receivedCursor,
		});
		settleExtractEvent(
			db,
			scope.principal,
			scope.scopeKey,
			event.eventId,
			"rejected",
			reason,
			now(),
		);
	}

	// --- reading the sources ----------------------------------------------------

	/**
	 * The CURRENT state and text of an event's source, or why it can not be curated: gone,
	 * superseded, too large, blocked (the exclusion ledger) or an assistant message that is
	 * not an adopted answer.
	 */
	function classify(
		db: Database,
		scope: ScopeRef,
		event: ExtractEventRow,
		blocked: ReadonlySet<string>,
	): Classified {
		const adapter = adapters.get(event.source.namespace);
		if (!adapter) return { kind: "final", reason: "SOURCE_ADAPTER_MISSING" };
		if (blocked.has(event.source.id))
			return { kind: "final", reason: "SOURCE_BLOCKED" };
		const access = accessOf(db, scope);
		const key: SourceKey = {
			namespace: event.source.namespace,
			kind: event.source.kind,
			id: event.source.id,
			representation: event.source.representation,
		};
		const current = adapter.resolveCurrent(db, access, key);
		if (
			current.status !== "available" ||
			current.principal !== scope.principal ||
			current.scopeKey !== scope.scopeKey ||
			current.speaker !== event.speaker
		)
			return { kind: "final", reason: "SOURCE_GONE" };
		if (
			current.revision !== event.source.revision ||
			current.digest !== event.source.digest
		)
			return { kind: "final", reason: "SUPERSEDED" };
		if (
			event.speaker === "assistant" &&
			!intake.isAdoptedAnswer(db, event.source.id)
		)
			return { kind: "final", reason: "NOT_ADOPTED" };
		const ref: SourceRef = {
			namespace: event.source.namespace,
			kind: event.source.kind,
			id: event.source.id,
			representation: event.source.representation,
			revision: current.revision,
			digest: current.digest,
		};
		const content = adapter.readAuthorizedContent(db, access, ref);
		if (content.status !== "ok")
			return { kind: "final", reason: "SOURCE_GONE" };
		if (utf8Length(content.text) > extractionLimits.maxWindowBytes)
			return { kind: "final", reason: "UTTERANCE_TOO_LARGE" };
		return {
			kind: "live",
			live: {
				event,
				ref,
				text: content.text,
				state: {
					...ref,
					principal: current.principal,
					scopeKey: current.scopeKey,
					status: "available",
					content: content.text,
				},
			},
		};
	}

	/** The row of an event still waiting for curation, or null. */
	const receivedEvent = (
		db: Database,
		scope: ScopeRef,
		eventId: string,
	): ExtractEventRow | null => {
		const row = getExtractEvent(db, scope.principal, scope.scopeKey, eventId);
		return row !== null && row.state === "received" ? row : null;
	};

	const reads = createReads({ world, purpose, now, hasher, accessOf });

	return {
		world,
		lifecycle,
		intake,
		purpose,
		now,
		hasher,
		memory,
		interpretationVersion,
		adapters,
		accessOf,
		unusable,
		manifestPrefix,
		releaseManifests,
		releaseEvents,
		settleOp,
		rejectEvent,
		classify,
		...reads,
		receivedEvent,
		options,
	};
}
export type CurationCtx = ReturnType<typeof createCurationCtx>;
