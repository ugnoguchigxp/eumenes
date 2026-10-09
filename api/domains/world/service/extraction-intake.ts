import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ScopeRef } from "eumenes-world-model";
import type {
	SourceChange,
	WorldApplyRequest,
	WorldApplyResult,
} from "../contracts";
import {
	appliedFrontier,
	countExtractEvents,
	getExtractEvent,
	insertExtractEvent,
	listExtractEventsBySourceKeys,
	nextExtractSeq,
	purgeExtractEvents,
	readExtractFeedScopeSet,
	type ExtractCounts,
} from "../repository/extraction";
import { readFeedCursor } from "../repository";
import { sourceKeyOf } from "./inputs";

/** Why a scanned change is not an extraction input (never delivered to World). */
export const SKIP_REASONS = [
	"WORLD_OFF",
	"GATE_CLOSED",
	"RECEIVE_REFUSED",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/**
 * Stable event identity of one source change: the same message revision
 * delivered again (a resend, a resync after a restore, a wider Scope set)
 * is the same event, whatever feed or cursor it arrives under.
 */
export function extractEventId(
	scope: ScopeRef,
	change: Pick<SourceChange, "source" | "revision" | "digest">,
): string {
	return `sx-${sha256(
		JSON.stringify([
			scope.principal,
			scope.scopeKey,
			change.source.namespace,
			change.source.kind,
			change.source.id,
			change.source.representation,
			change.revision,
			change.digest,
		]),
	).slice(0, 32)}`;
}

/** The sorted Scope keys of the principal that one feed spans; the host's Scope-set identity. */
export function scopeSetOf(
	scopes: readonly ScopeRef[],
	scope: ScopeRef,
): string[] {
	const keys = new Set([scope.scopeKey]);
	for (const s of scopes)
		if (s.principal === scope.principal) keys.add(s.scopeKey);
	return [...keys].sort();
}

/** A change a user made: the only kind of source change that can be an extraction input. */
export const isExtractionInput = (change: SourceChange): boolean =>
	(change.kind === "added" || change.kind === "corrected") &&
	change.speaker === "user";

export type ReceiveContext = {
	worldOp: (
		db: Database,
		scope: ScopeRef,
		operationKey: string,
		operation: WorldApplyRequest["operation"],
	) => WorldApplyResult;
	/** True when World may be used right now (ON, schema current, gate open). */
	usable: (db: Database) => { ok: true } | { ok: false; reason: SkipReason };
	now: () => number;
};

export type ReceiveReport = {
	received: number;
	skipped: number;
	duplicates: number;
};

/**
 * Persists the extraction inputs of one source-feed page: World `inbox.receive`
 * and the host's record in the CALLER's writer callback, which also saves the
 * feed cursor. A refusal other than "this event was forgotten" throws, so the
 * cursor does not move past an event World did not take.
 */
export function receiveSourceChanges(
	db: Database,
	ctx: ReceiveContext,
	scope: ScopeRef,
	feed: { scopeKeys: readonly string[]; restoreEpoch: string },
	changes: readonly SourceChange[],
): ReceiveReport {
	const report: ReceiveReport = { received: 0, skipped: 0, duplicates: 0 };
	for (const change of changes) {
		if (!isExtractionInput(change)) continue;
		const eventId = extractEventId(scope, change);
		if (getExtractEvent(db, scope.principal, scope.scopeKey, eventId)) {
			report.duplicates += 1;
			continue;
		}
		const ref = {
			namespace: change.source.namespace,
			kind: change.source.kind,
			id: change.source.id,
			representation: change.source.representation,
			revision: change.revision,
			digest: change.digest,
		};
		const base = {
			principal: scope.principal,
			scopeKey: scope.scopeKey,
			eventId,
			feedScopeKeys: feed.scopeKeys,
			feedRestoreEpoch: feed.restoreEpoch,
			receivedCursor: change.cursor,
			sourceKey: sourceKeyOf(change.source),
			source: ref,
			receivedAtMs: ctx.now(),
		};
		const usable = ctx.usable(db);
		if (!usable.ok) {
			insertExtractEvent(db, {
				...base,
				state: "skipped",
				reason: usable.reason,
			});
			report.skipped += 1;
			continue;
		}
		const seq = nextExtractSeq(db, scope.principal, scope.scopeKey);
		// The key carries the restore epoch: a re-delivery after a restore is a new operation.
		const result = ctx.worldOp(
			db,
			scope,
			`rx-${eventId}-${sha256(feed.restoreEpoch).slice(0, 12)}`,
			{
				kind: "inbox.receive",
				feed: {
					scopeKeys: [...feed.scopeKeys],
					kind: "source",
					cursorRestoreEpoch: feed.restoreEpoch,
				},
				event: {
					eventId,
					seq,
					payload: { change: change.kind, source: ref },
				},
				receivedCursor: change.cursor,
			},
		);
		if (result.status === "applied" || result.status === "no_op") {
			insertExtractEvent(db, { ...base, state: "received" });
			report.received += 1;
			continue;
		}
		// A forgotten event is not an input any more: nothing to receive, nothing to wait for.
		const reason = "reasonCode" in result ? result.reasonCode : "NOT_APPLIED";
		if (reason === "TOMBSTONED") continue;
		// Any other refusal is deterministic (a retry would be refused again). It
		// must not hold the cursor: a retraction or a correction on the same
		// page may not wait for it. The input is recorded as never extracted.
		insertExtractEvent(db, {
			...base,
			state: "skipped",
			reason: "RECEIVE_REFUSED",
		});
		report.skipped += 1;
	}
	return report;
}

/**
 * Forget roots of the extraction events these sources fed. World cannot reach
 * an unsettled inbox event from its source (its payload has no index), so the
 * host names it as a `candidate` root. Events never delivered (skipped) are
 * host-only and are simply deleted.
 */
export function candidateRootsFor(
	db: Database,
	scope: ScopeRef,
	sourceKeys: readonly string[],
): { kind: "candidate"; id: string; revision: number }[] {
	return listExtractEventsBySourceKeys(
		db,
		scope.principal,
		scope.scopeKey,
		sourceKeys,
	)
		.filter((event) => event.state !== "skipped")
		.map((event) => ({
			kind: "candidate" as const,
			id: event.eventId,
			revision: 1,
		}));
}

/** The host record of forgotten sources/events goes with the forget (any state). */
export function purgeForgotten(
	db: Database,
	scope: ScopeRef,
	roots: readonly { kind: string; id: string }[],
): number {
	return purgeExtractEvents(db, scope.principal, scope.scopeKey, {
		sourceKeys: roots.filter((r) => r.kind === "source").map((r) => r.id),
		eventIds: roots.filter((r) => r.kind === "candidate").map((r) => r.id),
	});
}

// --- progress query -------------------------------------------------------------

export type SourceFeedStages = {
	feed: "source";
	scope: ScopeRef;
	/** The source owner: does its outbox hold changes beyond what the host scanned? */
	owner: { ahead: boolean | "unknown" };
	/** The host's persisted position (an opaque cursor), or null before the first pass. */
	scanned: { cursor: string | null; restoreEpoch: string; stale: boolean };
	/**
	 * Delivered to World's inbox (`inbox.receive`). `lastCursor` is the cursor of
	 * the newest delivered event; changes that are not extraction inputs move
	 * `scanned` but not this.
	 */
	received: { count: number; lastCursor: string | null };
	/**
	 * Semantically settled (`candidate.settle` applied or rejected). `cursor` is the
	 * received cursor of the last event of the settled PREFIX: it never passes an
	 * unsettled event. `pending` events are not applied.
	 */
	applied: {
		cursor: string | null;
		applied: number;
		rejected: number;
		pending: number;
	};
	/** Scanned while World was OFF (or its gate closed): never delivered, never extracted. */
	skipped: number;
};

export type MemoryFeedStages = {
	feed: "memory";
	scope: ScopeRef;
	owner: { ahead: boolean | "unknown" };
	scanned: { cursor: string | null; restoreEpoch: string; stale: boolean };
	/** Memory notifications become forget intakes / invalidations in the same writer callback as the cursor. */
	note: "NO_INBOX_STAGE";
};

export type FeedStages = {
	source: SourceFeedStages;
	memory: MemoryFeedStages;
};

export function sourceFeedStages(
	db: Database,
	scope: ScopeRef,
	ownerAhead: boolean | "unknown",
): SourceFeedStages {
	const cursor = readFeedCursor(db, "source", scope.principal, scope.scopeKey);
	const counts: ExtractCounts = countExtractEvents(
		db,
		scope.principal,
		scope.scopeKey,
	);
	const frontier = appliedFrontier(db, scope.principal, scope.scopeKey);
	return {
		feed: "source",
		scope,
		owner: { ahead: ownerAhead },
		scanned: {
			cursor: cursor.cursor,
			restoreEpoch: cursor.restoreEpoch,
			stale: cursor.stale,
		},
		received: {
			count: counts.received + counts.applied + counts.rejected,
			lastCursor: counts.lastReceivedCursor,
		},
		applied: {
			cursor: frontier?.cursor ?? null,
			applied: counts.applied,
			rejected: counts.rejected,
			pending: counts.received,
		},
		skipped: counts.skipped,
	};
}

export function memoryFeedStages(
	db: Database,
	scope: ScopeRef,
	ownerAhead: boolean | "unknown",
): MemoryFeedStages {
	const cursor = readFeedCursor(db, "memory", scope.principal, scope.scopeKey);
	return {
		feed: "memory",
		scope,
		owner: { ahead: ownerAhead },
		scanned: {
			cursor: cursor.cursor,
			restoreEpoch: cursor.restoreEpoch,
			stale: cursor.stale,
		},
		note: "NO_INBOX_STAGE",
	};
}

/** True when the Scope set a cursor was saved under differs from the current one. */
export function scopeSetChanged(
	db: Database,
	feed: "source" | "memory",
	scope: ScopeRef,
	scopeKeys: readonly string[],
): boolean {
	const saved = readExtractFeedScopeSet(
		db,
		feed,
		scope.principal,
		scope.scopeKey,
	);
	return saved !== null && saved !== JSON.stringify(scopeKeys);
}
