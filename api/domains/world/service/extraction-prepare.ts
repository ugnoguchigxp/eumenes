import { prepareExtraction, type ScopeRef } from "eumenes-world-model";
import {
	listExtractEventsByIds,
	listOpenExtractEvents,
	setExtractPrepared,
	unassignExtractEvents,
} from "../repository/extraction";
import { upsertDependent } from "../repository/lifecycle";
import { isMemoryStateItem } from "./inputs";
import {
	MemoryRegistrationRejected,
	planDependents,
	registerWorldDependents,
} from "./memory-adapter";
import {
	type Message,
	type PreparedEvent,
	type PreparedExtraction,
	type ExtractionHandler,
} from "./extraction-types";
import {
	MAX_OUTPUT_TOKENS,
	FOREGROUND_ACTIVE,
	SLOT_BUSY,
	short,
	SYSTEM_PROMPT,
} from "./extraction-shared";
import type { ExtractionCtx } from "./extraction-ctx";
import type { ExtractionEvents, Live } from "./extraction-events";

export function createPrepare(
	ctx: ExtractionCtx,
	events: ExtractionEvents,
): Pick<ExtractionHandler, "prepareInTransaction"> {
	const {
		options,
		inference,
		now,
		hasher,
		budgetMs,
		confirmMs,
		hook,
		foregroundActive,
		slot,
		accessOf,
		usable,
		releaseManifests,
		endJob,
	} = ctx;
	const { rejectEvent, classify } = events;

	return {
		prepareInTransaction(db, claim) {
			const scope: ScopeRef = {
				principal: claim.payload.principal,
				scopeKey: claim.payload.scopeKey,
			};
			const refusal = usable(db);
			if (refusal) return { status: "stale", reason: refusal };
			// Foreground first; and no second Local call while an earlier one is
			// unconfirmed. The claim is cancelled by the queue, the events go back to
			// the pool untouched (no failure, no backoff) and a later schedule
			// resumes them as a NEW attempt. Nothing sleeps here.
			const hold = foregroundActive()
				? FOREGROUND_ACTIVE
				: slot.inFlight
					? SLOT_BUSY
					: null;
			if (hold) {
				unassignExtractEvents(
					db,
					scope.principal,
					scope.scopeKey,
					listExtractEventsByIds(
						db,
						scope.principal,
						scope.scopeKey,
						claim.payload.eventIds,
					)
						.filter((e) => e.state === "received" && e.jobId === claim.jobId)
						.map((e) => e.eventId),
				);
				return { status: "stale", reason: hold };
			}
			const held = listExtractEventsByIds(
				db,
				scope.principal,
				scope.scopeKey,
				claim.payload.eventIds,
			).filter((e) => e.state === "received" && e.jobId === claim.jobId);
			if (held.length === 0) return { status: "stale", reason: "no_input" };
			// Only the oldest unsettled events may be settled: a window is a prefix.
			const oldest = listOpenExtractEvents(
				db,
				scope.principal,
				scope.scopeKey,
				held.length,
			);
			let matched = 0;
			while (
				matched < held.length &&
				oldest[matched]?.eventId === held[matched]!.eventId
			)
				matched += 1;
			const ordered = held.slice(0, matched);
			if (ordered.length === 0) {
				unassignExtractEvents(
					db,
					scope.principal,
					scope.scopeKey,
					held.map((e) => e.eventId),
				);
				return { status: "stale", reason: "not_oldest" };
			}
			const live: Live[] = [];
			let stopAt = ordered.length;
			for (const [index, event] of ordered.entries()) {
				const verdict = classify(db, scope, event);
				if (verdict.kind === "live") {
					live.push(verdict.live);
					continue;
				}
				// Permanent: settled now when nothing live precedes it, else it
				// leads the next window.
				if (live.length === 0) {
					rejectEvent(db, scope, event, verdict.reason);
					continue;
				}
				stopAt = index;
				break;
			}
			unassignExtractEvents(
				db,
				scope.principal,
				scope.scopeKey,
				[...held.slice(matched), ...ordered.slice(stopAt)].map(
					(e) => e.eventId,
				),
			);
			if (live.length === 0) return { status: "stale", reason: "no_input" };

			const utterances = live.map((l) => ({
				utteranceId: l.event.eventId,
				source: l.ref,
				confirmed: true,
				origin: "user_report" as const,
				rootEvidenceId: `root-${short(`${scope.principal}\u0000${scope.scopeKey}\u0000${l.ref.id}`)}`,
			}));
			const prepared = prepareExtraction(
				{
					contractVersion: 1,
					scope,
					utterances,
					sources: { states: live.map((l) => l.state) },
					extraDependencies: [],
				},
				hasher,
			);
			if (!prepared.ok || prepared.value.status !== "prepared") {
				endJob(db, scope, claim.jobId, true);
				return {
					status: "stale",
					reason: prepared.ok
						? `held_${prepared.value.holdReason ?? "none"}`.toLowerCase()
						: "prepare_invalid",
				};
			}
			const window = prepared.value.window;
			const inWindow = new Set(window.map((u) => u.utteranceId));
			// What did not fit stays for the next window.
			unassignExtractEvents(
				db,
				scope.principal,
				scope.scopeKey,
				live
					.filter((l) => !inWindow.has(l.event.eventId))
					.map((l) => l.event.eventId),
			);
			const chosen = live.filter((l) => inWindow.has(l.event.eventId));
			const dependencies = [...prepared.value.manifest.dependencies];
			const windowId = short(
				JSON.stringify([
					scope.principal,
					scope.scopeKey,
					chosen.map((l) => [l.event.eventId, l.ref.revision, l.ref.digest]),
				]),
			);
			const events: PreparedEvent[] = chosen.map((l, index) => ({
				eventId: l.event.eventId,
				manifestId: `xm-${windowId}-${index}`,
				ref: l.ref,
			}));

			// Memory must know what the model is about to see BEFORE it sees it.
			const planned = planDependents(
				events.map((e) => ({
					tag: "m" as const,
					key: [e.manifestId],
					refs: dependencies,
				})),
				scope,
				{ isStateItem: isMemoryStateItem },
			);
			if ("status" in planned) {
				endJob(db, scope, claim.jobId, true);
				return {
					status: "stale",
					reason: `memory_${planned.reasonCode.toLowerCase()}`,
				};
			}
			const registerSavepoint = "world_extract_register";
			db.exec(`SAVEPOINT ${registerSavepoint}`);
			try {
				registerWorldDependents(db, {
					access: accessOf(db, scope),
					scopeKey: scope.scopeKey,
					clockMs: now(),
					dependents: planned.dependents,
				});
				for (const dependent of planned.dependents)
					upsertDependent(
						db,
						scope.principal,
						scope.scopeKey,
						dependent.externalId,
						dependent.dependsOn.map((dependency) => ({
							type: dependency.type,
							id: dependency.id,
							key:
								planned.worldKeys.get(
									`${dependency.type}\u0000${dependency.id}`,
								) ?? dependency.id,
						})),
					);
				db.exec(`RELEASE ${registerSavepoint}`);
			} catch (error) {
				db.exec(`ROLLBACK TO ${registerSavepoint}`);
				db.exec(`RELEASE ${registerSavepoint}`);
				if (!(error instanceof MemoryRegistrationRejected)) throw error;
				endJob(db, scope, claim.jobId, true);
				return {
					status: "stale",
					reason: `memory_${error.reasonCode.toLowerCase()}`,
				};
			}

			// The Local-only model request. Cloud is never an option.
			const subject = `world-extract:${claim.jobId}:${claim.attempt}`;
			let requestId: string;
			try {
				requestId = inference.captureMaintenanceControlInTransaction(db, {
					subject,
					deadline: Date.now() + budgetMs + confirmMs,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
				});
			} catch {
				releaseManifests(
					db,
					scope,
					events.map((e) => e.manifestId),
				);
				endJob(db, scope, claim.jobId, true);
				return { status: "stale", reason: "local_provider_unavailable" };
			}
			const snapshot = inference.snapshotFor?.(db, subject) ?? null;
			if (
				!snapshot ||
				snapshot.routes.llm.mode !== "larm-only" ||
				snapshot.routes.llm.cloudAllowed !== false
			) {
				inference.cancelRequestsInTransaction(db, [requestId]);
				releaseManifests(
					db,
					scope,
					events.map((e) => e.manifestId),
				);
				endJob(db, scope, claim.jobId, true);
				return { status: "stale", reason: "local_provider_required" };
			}
			for (const e of events)
				setExtractPrepared(
					db,
					scope.principal,
					scope.scopeKey,
					e.eventId,
					e.manifestId,
					requestId,
				);

			const entities = [...(options.entities?.(db, scope) ?? [])];
			const messages: Message[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: JSON.stringify({
						utterances: chosen.map((l) => ({
							utteranceId: l.event.eventId,
							text: l.text,
						})),
						entities,
					}),
				},
			];
			const input: PreparedExtraction = {
				scope,
				jobId: claim.jobId,
				windowId,
				events,
				dependencies,
				window: window.map((u) => ({
					utteranceId: u.utteranceId,
					source: u.source,
					origin: "user_report" as const,
					rootEvidenceId: u.rootEvidenceId,
				})),
				entities,
				requestId,
				messages,
				dependentIds: planned.dependents.map((d) => d.externalId),
			};
			hook("prepared", claim.jobId);
			return { status: "ready", input };
		},
	};
}
