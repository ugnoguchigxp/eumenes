import type { Database } from "bun:sqlite";
import { prepareExtraction, type ScopeRef } from "eumenes-world-model";
import {
	listExtractEventsByIds,
	setExtractManifest,
	type ExtractEventRow,
} from "../repository/extraction";
import { upsertDependent } from "../repository/lifecycle";
import { isMemoryStateItem } from "./inputs";
import {
	MemoryRegistrationRejected,
	planDependents,
	registerWorldDependents,
} from "./memory-adapter";
import type { CurationCtx, Live } from "./curation-ctx";
import { short } from "./curation-ctx";
import type {
	CurationFinalized,
	CurationHostEvent,
	CurationPrepareResult,
} from "./curation-types";
import { describeView, selectView } from "./curation-view";

/**
 * Re-reads the sources, fixes the window and registers Memory's external dependents BEFORE any
 * model sees the text. May write even when the answer is not `ready`: events whose source can
 * not be curated any more are settled `rejected` for good (and reported in `finalized`), so the
 * caller commits its transaction whatever the status is.
 */
export function createPrepare(ctx: CurationCtx) {
	const { world, now, hasher, intake, accessOf, classify, rejectEvent } = ctx;

	return function prepareCurationInTransaction(
		db: Database,
		input: { scope: ScopeRef; eventIds: readonly string[] },
	): CurationPrepareResult {
		const { scope } = input;
		const finalized: CurationFinalized[] = [];
		const stale = (reason: string): CurationPrepareResult => ({
			status: "stale",
			reason,
			finalized,
		});
		const notReady = (reason: string): CurationPrepareResult => ({
			status: "not_ready",
			reason,
			finalized,
		});
		if (ctx.unusable(db)) return notReady("world_unavailable");

		const requested = new Set(input.eventIds);
		const rows = listExtractEventsByIds(db, scope.principal, scope.scopeKey, [
			...requested,
		])
			.filter((row) => row.state === "received" && row.conversationId !== null)
			.sort((a, b) => a.seq - b.seq);
		if (rows.length === 0) return stale("no_input");

		const blocked = intake.blockedMessageIds(
			db,
			rows.map((row) => row.source.id),
		);
		const live: Live[] = [];
		for (const row of rows) {
			const verdict = classify(db, scope, row, blocked);
			if (verdict.kind === "live") {
				live.push(verdict.live);
				continue;
			}
			// A source that can not be curated any more is final: it never gets another try.
			rejectEvent(db, scope, row, verdict.reason);
			finalized.push({
				eventId: row.eventId,
				messageId: row.source.id,
				reason: verdict.reason,
			});
		}
		if (live.length === 0) return stale("no_input");

		const digest = ctx.entityDigest(db, scope);
		if (digest === null) return notReady("world_unavailable");
		// A window that was held waits until the entities change (only that can resolve it).
		const open = live.filter((l) => l.event.heldContextDigest !== digest);
		if (open.length === 0) return notReady("extraction_context_held");

		const speakerOrigin = (row: ExtractEventRow) =>
			row.speaker === "user"
				? ("user_report" as const)
				: ("document_claim" as const);
		const prepared = prepareExtraction(
			{
				contractVersion: 1,
				scope,
				utterances: open.map((l) => ({
					utteranceId: l.event.eventId,
					source: l.ref,
					confirmed: true,
					origin: speakerOrigin(l.event),
					rootEvidenceId: `root-${short(`${scope.principal}\u0000${scope.scopeKey}\u0000${l.ref.id}`)}`,
				})),
				sources: { states: open.map((l) => l.state) },
				extraDependencies: [],
			},
			hasher,
		);
		if (!prepared.ok || prepared.value.status !== "prepared")
			return notReady(
				prepared.ok
					? `held_${prepared.value.holdReason ?? "none"}`.toLowerCase()
					: "prepare_invalid",
			);
		const window = prepared.value.window;
		const inWindow = new Set(window.map((u) => u.utteranceId));
		const chosen = open.filter((l) => inWindow.has(l.event.eventId));
		const deferredEventIds = rows
			.map((row) => row.eventId)
			.filter(
				(id) => !inWindow.has(id) && !finalized.some((f) => f.eventId === id),
			);
		const dependencies = [...prepared.value.manifest.dependencies];
		const windowId = short(
			JSON.stringify([
				scope.principal,
				scope.scopeKey,
				chosen.map((l) => [l.event.eventId, l.ref.revision, l.ref.digest]),
			]),
		);
		const events: CurationHostEvent[] = chosen.map((l, index) => ({
			label: `e${index + 1}`,
			eventId: l.event.eventId,
			messageId: l.ref.id,
			conversationId: l.event.conversationId as string,
			speaker: l.event.speaker,
			source: l.ref,
			manifestId: `xm-${windowId}-${index}`,
			rootEvidenceId: `root-${short(`${scope.principal}\u0000${scope.scopeKey}\u0000${l.ref.id}`)}`,
			receivedCursor: l.event.receivedCursor,
		}));

		const view = selectView(
			ctx,
			db,
			scope,
			chosen.map((l) => l.text),
		);
		if (view === null) return notReady("world_unavailable");

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
		if ("status" in planned)
			return notReady(`memory_${planned.reasonCode.toLowerCase()}`);
		const savepoint = "world_curation_register";
		db.exec(`SAVEPOINT ${savepoint}`);
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
			db.exec(`RELEASE ${savepoint}`);
		} catch (error) {
			db.exec(`ROLLBACK TO ${savepoint}`);
			db.exec(`RELEASE ${savepoint}`);
			if (!(error instanceof MemoryRegistrationRejected)) throw error;
			return notReady(`memory_${error.reasonCode.toLowerCase()}`);
		}
		for (const e of events)
			setExtractManifest(
				db,
				scope.principal,
				scope.scopeKey,
				e.eventId,
				e.manifestId,
			);

		const described = describeView(ctx, scope, view);
		return {
			status: "ready",
			finalized,
			prepared: {
				scope,
				eventIds: events.map((e) => e.eventId),
				deferredEventIds,
				model: {
					utterances: chosen.map((l, index) => ({
						label: `e${index + 1}`,
						speaker: l.event.speaker,
						text: l.text,
					})),
					entities: described.entities,
					claims: described.claims,
				},
				host: {
					version: 1,
					windowId,
					forgetEpoch: world.forgetEpoch(db, scope),
					entityDigest: digest,
					events,
					dependencies,
					dependentIds: planned.dependents.map((d) => d.externalId),
					window: window.map((u) => ({
						utteranceId: u.utteranceId,
						source: u.source,
						origin: u.origin,
						rootEvidenceId: u.rootEvidenceId,
					})),
					...described.table,
				},
			},
		};
	};
}
