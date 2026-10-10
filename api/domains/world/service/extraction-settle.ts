import type { SourceState } from "eumenes-memory";
import {
	validateCandidates,
	type Assertion,
	type ScopeRef,
} from "eumenes-world-model";
import {
	clearExtractPrepared,
	getExtractEvent,
	settleExtractEvent,
} from "../repository/extraction";
import {
	type ExtractionHandler,
	type ExtractionReport,
} from "./extraction-types";
import {
	FRESHNESS_MAX_AGE_MS,
	MAX_ASSIGNED,
	isForegroundCode,
} from "./extraction-shared";
import type { ExtractionCtx } from "./extraction-ctx";
import type { ExtractionEvents } from "./extraction-events";

export function createSettle(
	ctx: ExtractionCtx,
	events: ExtractionEvents,
): Pick<ExtractionHandler, "settleInTransaction" | "cancelInTransaction"> {
	const {
		options,
		inference,
		now,
		hasher,
		interpretationVersion,
		hook,
		usable,
		releaseManifests,
		endJob,
	} = ctx;
	const { appliedCursorOf, settleOp, rejectEvent, classify } = events;

	return {
		settleInTransaction(db, claim, input, outcome) {
			const scope: ScopeRef = {
				principal: claim.payload.principal,
				scopeKey: claim.payload.scopeKey,
			};
			const report = (
				disposition: ExtractionReport["disposition"],
				extra: Partial<ExtractionReport> = {},
			) =>
				options.onReport?.({
					jobId: claim.jobId,
					disposition,
					reasons: [],
					events: input?.events.length ?? 0,
					accepted: 0,
					held: 0,
					rejected: 0,
					...extra,
				});
			if (outcome.type === "retry") {
				// The same job runs again: keep its events, withdraw this attempt.
				if (input) {
					clearExtractPrepared(db, claim.jobId);
					inference.cancelRequestsInTransaction(db, [input.requestId]);
					releaseManifests(
						db,
						scope,
						input.events.map((e) => e.manifestId),
					);
				}
				return "applied";
			}
			if (outcome.type !== "success") {
				// A call ended for the foreground is not the input's fault: the events
				// go back to the pool with no failure count and no backoff.
				endJob(
					db,
					scope,
					claim.jobId,
					(outcome.type === "failed" && !isForegroundCode(outcome.errorCode)) ||
						outcome.type === "expired",
				);
				report("not_adopted", { reasons: [outcome.type] });
				return "applied";
			}
			if (!input) {
				endJob(db, scope, claim.jobId, true);
				return "applied";
			}
			hook("settle_begin", claim.jobId);
			const { receipt, text } = outcome.result;
			// A late result of an OLD attempt (the same job was prepared again, so
			// its events carry another request id) is refused. It touches nothing the
			// newer attempt holds: not its manifests, not its request, not its events.
			const newer = input.events.some((e) => {
				const row = getExtractEvent(
					db,
					scope.principal,
					scope.scopeKey,
					e.eventId,
				);
				return (
					row !== null &&
					row.state === "received" &&
					row.jobId === claim.jobId &&
					row.requestId !== input.requestId
				);
			});
			if (newer) {
				inference.rejectControlInTransaction(db, receipt, "stale_attempt");
				report("not_adopted", { reasons: ["stale_attempt"] });
				return "stale";
			}
			const notAdopted = (reason: string, failure = false) => {
				inference.rejectControlInTransaction(db, receipt, reason);
				endJob(db, scope, claim.jobId, failure);
				report("not_adopted", { reasons: [reason] });
				return "applied" as const;
			};
			const blocked = usable(db);
			if (blocked) return notAdopted(blocked);
			// The events this job still owns (a forget or a restore may have removed some).
			const events = input.events.flatMap((e) => {
				const row = getExtractEvent(
					db,
					scope.principal,
					scope.scopeKey,
					e.eventId,
				);
				return row && row.state === "received" && row.jobId === claim.jobId
					? [{ prepared: e, row }]
					: [];
			});
			if (events.length !== input.events.length)
				return notAdopted("input_changed");

			// Re-read the sources: ANY version that moved since prepare voids the result.
			const states: SourceState[] = [];
			for (const { row, prepared } of events) {
				const verdict = classify(db, scope, row);
				if (
					verdict.kind !== "live" ||
					verdict.live.ref.revision !== prepared.ref.revision ||
					verdict.live.ref.digest !== prepared.ref.digest
				)
					return notAdopted("input_version_changed");
				states.push(verdict.live.state);
			}
			if (!inference.acceptInTransaction(db, receipt))
				return notAdopted("inference_not_accepted", true);

			const base = {
				contractVersion: 1,
				scope,
				window: input.window,
				manifest: { dependencies: input.dependencies },
				sources: { states },
				entities: input.entities,
				assigned: {
					recordedAt: now(),
					interpretationVersion,
					freshnessMaxAgeMs: FRESHNESS_MAX_AGE_MS,
					items: Array.from({ length: MAX_ASSIGNED }, (_, i) => ({
						assertionId: `ax-${input.windowId}-${i}`,
						evidenceId: `ex-${input.windowId}-${i}`,
					})),
				},
				modelOutput: text,
			};
			const first = validateCandidates(base, hasher);
			if (!first.ok) {
				// A host-side input error, not a verdict about the model.
				endJob(db, scope, claim.jobId, true);
				inference.rejectControlInTransaction(db, receipt, "validation_input");
				report("not_adopted", { reasons: ["validation_input"] });
				return "applied";
			}
			if (first.value.status === "rejected") {
				// Unusable output (not parseable / over the byte limit): final for these events.
				inference.rejectControlInTransaction(db, receipt, "output_rejected");
				releaseManifests(
					db,
					scope,
					events.map((e) => e.prepared.manifestId),
				);
				for (const { row } of events)
					rejectEvent(db, scope, row, "OUTPUT_REJECTED");
				report("output_rejected", {
					reasons: [first.value.reasonCode ?? "MALFORMED_OUTPUT"],
					rejected: events.length,
				});
				return "applied";
			}
			const selected = first.value.acceptedIndexes;
			const second = validateCandidates(
				{ ...base, selectedIndexes: selected },
				hasher,
			);
			if (!second.ok || second.value.status !== "validated") {
				endJob(db, scope, claim.jobId, true);
				inference.rejectControlInTransaction(db, receipt, "selection_invalid");
				report("not_adopted", { reasons: ["selection_invalid"] });
				return "applied";
			}
			const verdicts = second.value.verdicts;
			const reasons = [
				...new Set(
					verdicts.flatMap((v) =>
						v.status === "accepted" ? [] : v.reasonCodes,
					),
				),
			].sort();
			const bySource = new Map<string, Assertion[]>();
			for (const item of second.value.handoff) {
				const draft = item.draft;
				const sourceId = draft.evidence[0]?.source.id;
				const assertion = {
					...draft,
					lifecycle: "candidate",
					rootEvidenceIds: [
						...new Set(draft.evidence.map((e) => e.rootEvidenceId)),
					].sort(),
				} as Assertion;
				const list = bySource.get(sourceId ?? "") ?? [];
				list.push(assertion);
				bySource.set(sourceId ?? "", list);
			}
			for (const { prepared, row } of events) {
				settleOp(db, scope, row, {
					disposition: "applied",
					manifest: {
						manifestId: prepared.manifestId,
						dependencies: input.dependencies,
					},
					assertions: bySource.get(prepared.ref.id) ?? [],
					appliedCursor: appliedCursorOf(db, scope, row),
				});
				settleExtractEvent(
					db,
					scope.principal,
					scope.scopeKey,
					row.eventId,
					"applied",
					null,
					now(),
				);
				hook("event_settled", claim.jobId);
			}
			report("adopted", {
				reasons,
				accepted: second.value.handoff.length,
				held: verdicts.filter((v) => v.status === "held").length,
				rejected: verdicts.filter((v) => v.status === "rejected").length,
			});
			return "applied";
		},

		cancelInTransaction(db, job) {
			endJob(
				db,
				{
					principal: job.payload.principal,
					scopeKey: job.payload.scopeKey,
				},
				job.jobId,
				false,
			);
		},
	};
}
