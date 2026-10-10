import type { Database } from "bun:sqlite";
import type { SourceRef, SourceState } from "eumenes-memory";
import { extractionLimits, type ScopeRef } from "eumenes-world-model";
import { type SourceKey } from "../contracts";
import {
	assignExtractJob,
	listOpenExtractEvents,
	settleExtractEvent,
	type ExtractEventRow,
} from "../repository/extraction";
import {
	WORLD_EXTRACT_KIND,
	FOREGROUND_ACTIVE,
	SLOT_BUSY,
	short,
	utf8Length,
	OPEN_JOB_STATES,
} from "./extraction-shared";
import type { ExtractionCtx } from "./extraction-ctx";

export type Live = {
	event: ExtractEventRow;
	ref: SourceRef;
	state: SourceState;
	text: string;
};
export type Classified =
	| { kind: "live"; live: Live }
	| { kind: "final"; reason: string };

/** Settling events, reading their sources and handing them to the queue. */
export function createExtractionEvents(ctx: ExtractionCtx) {
	const {
		world,
		queue,
		purpose,
		now,
		newId,
		adapters,
		foregroundActive,
		slot,
		accessOf,
		usable,
	} = ctx;

	// --- World settle helpers --------------------------------------------------

	/**
	 * The applied cursor of an event is its own received cursor, and only when
	 * it is the oldest unsettled event: the applied position never passes an
	 * unsettled one.
	 */
	function appliedCursorOf(
		db: Database,
		scope: ScopeRef,
		event: ExtractEventRow,
	): string {
		const oldest = listOpenExtractEvents(
			db,
			scope.principal,
			scope.scopeKey,
			1,
		)[0];
		if (!oldest || oldest.eventId !== event.eventId)
			throw new Error("world_extract_out_of_order");
		return event.receivedCursor;
	}

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
			throw new Error("world_extract_settle_refused");
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
			appliedCursor: appliedCursorOf(db, scope, event),
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

	/** The CURRENT state and text of an event's source, or why it can not be extracted. */
	function classify(
		db: Database,
		scope: ScopeRef,
		event: ExtractEventRow,
	): Classified {
		const adapter = adapters.get(event.source.namespace);
		if (!adapter) return { kind: "final", reason: "SOURCE_ADAPTER_MISSING" };
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
			current.scopeKey !== scope.scopeKey
		)
			return { kind: "final", reason: "SOURCE_GONE" };
		if (
			current.revision !== event.source.revision ||
			current.digest !== event.source.digest
		)
			return { kind: "final", reason: "SUPERSEDED" };
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

	// --- scheduling -------------------------------------------------------------

	/**
	 * Hands the oldest unsettled extraction inputs to ONE queue job. No input
	 * (an empty feed, nothing but settled or backed-off events) creates no job
	 * and so no model request. Runs in the caller's writer callback.
	 */
	function scheduleInTransaction(
		db: Database,
		scope: ScopeRef,
	):
		| { status: "scheduled"; jobId: string; events: number }
		| { status: "idle"; reason: string } {
		const blocked = usable(db);
		if (blocked) return { status: "idle", reason: blocked };
		// Foreground first, and never a second Local call while one (possibly
		// cancelled but unconfirmed) is still on the provider: hold, create nothing.
		if (foregroundActive())
			return { status: "idle", reason: FOREGROUND_ACTIVE };
		if (slot.inFlight) return { status: "idle", reason: SLOT_BUSY };
		const open = listOpenExtractEvents(
			db,
			scope.principal,
			scope.scopeKey,
			extractionLimits.maxUtterances * 4,
		);
		if (open.length === 0) return { status: "idle", reason: "no_input" };
		const head = open[0]!;
		if (head.jobId) {
			const job = queue.getInTransaction(db, head.jobId);
			if (job && OPEN_JOB_STATES.has(job.state))
				return { status: "idle", reason: "job_open" };
		}
		if (head.retryAtMs > now()) return { status: "idle", reason: "backoff" };
		const events = open.slice(0, extractionLimits.maxUtterances);
		const { job } = queue.enqueueInTransaction(db, {
			scope: "world",
			kind: WORLD_EXTRACT_KIND,
			dedupeKey: `x:${head.eventId}:${newId()}`,
			payload: {
				principal: scope.principal,
				scopeKey: scope.scopeKey,
				eventIds: events.map((e) => e.eventId),
			},
			subjectRef: `world:${short(`${scope.principal}\u0000${scope.scopeKey}`)}`,
			lane: "background",
			resourceKey: "inference.llm",
			maxAttempts: 2,
		});
		assignExtractJob(
			db,
			scope.principal,
			scope.scopeKey,
			events.map((e) => e.eventId),
			job.id,
		);
		return { status: "scheduled", jobId: job.id, events: events.length };
	}

	return {
		appliedCursorOf,
		settleOp,
		rejectEvent,
		classify,
		scheduleInTransaction,
	};
}
export type ExtractionEvents = ReturnType<typeof createExtractionEvents>;
