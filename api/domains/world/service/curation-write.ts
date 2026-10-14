import type { Database } from "bun:sqlite";
import type { Assertion } from "eumenes-world-model";
import {
	settleExtractEvent,
	type ExtractEventRow,
} from "../repository/extraction";
import type { Adoption } from "./curation-adopt";
import { CurationError, type CurationCtx } from "./curation-ctx";
import type { OutputPlan } from "./curation-plan";
import type { Apply } from "./curation-validate";
import type {
	CurationElement,
	CurationSettleResult,
	PreparedCuration,
} from "./curation-types";

/** New entities first, then each event in order: candidate.settle, adoption, correction, retraction. */
export function write(
	ctx: CurationCtx,
	adoption: Adoption,
	db: Database,
	prepared: PreparedCuration,
	rows: readonly ExtractEventRow[],
	plan: OutputPlan,
	todo: readonly Apply[],
): Extract<CurationSettleResult, { status: "settled" }> {
	const { scope, host } = prepared;
	const { world, now } = ctx;
	const elements = plan.elements;
	for (const [index, entity] of plan.newEntities) {
		const result = world.applyInWriter(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose: ctx.purpose,
			},
			scope,
			operationKey: `xe-${host.windowId}-${index}`,
			clock: now(),
			operation: {
				kind: "entity.register",
				entity: {
					id: entity.id,
					displayName: entity.displayName,
					aliases: entity.aliases,
					externalRefs: [],
				},
			},
		});
		if (result.status !== "applied" && result.status !== "no_op")
			throw new CurationError(
				`entity_refused_${"reasonCode" in result ? result.reasonCode : result.status}`,
			);
		elements.push({
			kind: "entity",
			index,
			op: "register",
			status: "applied",
			reasonCodes: [],
			outcome: "registered",
			entityId: entity.id,
		});
	}
	const claimIds: string[] = [];
	for (const [position, event] of host.events.entries()) {
		const mine = todo.filter((t) => t.p.event.eventId === event.eventId);
		ctx.settleOp(db, scope, rows[position]!, {
			disposition: "applied",
			manifest: {
				manifestId: event.manifestId,
				dependencies: host.dependencies,
			},
			assertions: mine.flatMap((t) =>
				t.how === "assert" ? [t.assertion] : [],
			),
			appliedCursor: event.receivedCursor,
		});
		settleExtractEvent(
			db,
			scope.principal,
			scope.scopeKey,
			event.eventId,
			"applied",
			null,
			now(),
		);
		for (const t of mine) {
			const key = `xa-${host.windowId}-${t.p.index}`;
			const base: CurationElement = {
				kind: "claim",
				index: t.p.index,
				op: t.p.claim.op,
				status: "applied",
				reasonCodes: [],
				messageId: event.messageId,
			};
			if (t.how === "assert") {
				adoption.adopt(db, scope, key, {
					id: t.assertion.id,
					revision: 1,
					origin: t.assertion.origin,
				});
				claimIds.push(t.assertion.id);
				elements.push({
					...base,
					claimId: t.assertion.id,
					outcome:
						t.assertion.origin === "model_hypothesis"
							? "adopted_hypothesis"
							: "adopted",
				});
				continue;
			}
			const refused =
				t.how === "correct"
					? adoption.correct(db, scope, key, t.old, {
							...t.assertion,
							id: t.old.id,
							revision: t.old.revision + 1,
							supersedes: [{ id: t.old.id, revision: t.old.revision }],
							condition: t.old.assertion.condition,
							freshnessPolicy: t.old.assertion.freshnessPolicy,
						} as Assertion)
					: adoption.retract(db, scope, key, t.old, event.source);
			if (refused) {
				elements.push({
					...base,
					status: "dropped",
					reasonCodes: ["claim_not_changeable", refused.rejected],
				});
				continue;
			}
			claimIds.push(t.old.id);
			elements.push({
				...base,
				claimId: t.old.id,
				outcome: t.how === "correct" ? "corrected" : "retracted",
			});
		}
	}
	elements.sort(
		(a, b) =>
			(a.kind === b.kind ? 0 : a.kind === "entity" ? -1 : 1) ||
			a.index - b.index,
	);
	const applied = elements.filter((e) => e.status === "applied");
	return {
		status: "settled",
		elements,
		eventIds: host.events.map((e) => e.eventId),
		touched: {
			claimIds: [...new Set(claimIds)].sort(),
			entityIds: applied
				.flatMap((e) => (e.entityId ? [e.entityId] : []))
				.sort(),
			messageIds: [
				...new Set(applied.flatMap((e) => (e.messageId ? [e.messageId] : []))),
			].sort(),
		},
		changed: applied.length > 0,
	};
}
