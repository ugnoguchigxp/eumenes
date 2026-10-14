import type { Database } from "bun:sqlite";
import type { SourceState } from "eumenes-memory";
import {
	extractionLimits,
	validateCandidates,
	type Assertion,
	type ProjectionEntry,
} from "eumenes-world-model";
import { holdExtractEvents } from "../repository/extraction";
import {
	CurationError,
	FRESHNESS_MAX_AGE_MS,
	type CurationCtx,
} from "./curation-ctx";
import type { OutputPlan, Planned } from "./curation-plan";
import type {
	CurationElement,
	CurationSettleResult,
	PreparedCuration,
} from "./curation-types";

/** Key order does not matter for "the same claim". */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export type Validated = {
	accepted: Map<number, Assertion>;
	rejections: Map<number, string[]>;
};

/**
 * The package validates every candidate. One unplaced candidate holds the WHOLE window: nothing is
 * written, the events wait until the entities change (the held result is returned).
 */
export function validate(
	ctx: CurationCtx,
	db: Database,
	prepared: PreparedCuration,
	plan: OutputPlan,
	states: ReadonlyMap<string, SourceState>,
): Validated | Extract<CurationSettleResult, { status: "held" }> {
	const { scope, host } = prepared;
	const accepted = new Map<number, Assertion>();
	const rejections = new Map<number, string[]>();
	if (plan.candidates.length === 0) return { accepted, rejections };
	const base = {
		contractVersion: 1,
		scope,
		window: host.window,
		manifest: { dependencies: host.dependencies },
		sources: { states: host.events.map((e) => states.get(e.eventId)!) },
		entities: [...host.entitySnapshot, ...plan.newEntities.values()],
		assigned: {
			recordedAt: ctx.now(),
			interpretationVersion: ctx.interpretationVersion,
			freshnessMaxAgeMs: FRESHNESS_MAX_AGE_MS,
			items: Array.from(
				{ length: extractionLimits.maxRawCandidates },
				(_, i) => ({
					assertionId: `ax-${host.windowId}-${i}`,
					evidenceId: `ex-${host.windowId}-${i}`,
				}),
			),
		},
		modelOutput: { candidates: plan.candidates },
	};
	const first = validateCandidates(base, ctx.hasher);
	// Everything the validator reads was built here: a failure is a host fault.
	if (!first.ok || first.value.status !== "validated")
		throw new CurationError("validation_input");
	const second = validateCandidates(
		{ ...base, selectedIndexes: first.value.acceptedIndexes },
		ctx.hasher,
	);
	if (!second.ok || second.value.status !== "validated")
		throw new CurationError("selection_invalid");
	const held = second.value.verdicts.flatMap((v) =>
		v.status === "held" ? [v] : [],
	);
	if (held.length > 0) {
		const eventIds = host.events.map((e) => e.eventId);
		ctx.releaseEvents(db, scope, eventIds);
		holdExtractEvents(
			db,
			scope.principal,
			scope.scopeKey,
			eventIds,
			ctx.entityDigest(db, scope) ?? host.entityDigest,
		);
		const reasonsOf = new Map(
			second.value.verdicts.map((v) => [
				v.index,
				v.status === "accepted" ? [] : [...v.reasonCodes],
			]),
		);
		return {
			status: "held",
			reasonCodes: [...new Set(held.flatMap((v) => [...v.reasonCodes]))].sort(),
			elements: plan.planned.map((p): CurationElement => {
				const own =
					p.candidate === undefined ? [] : (reasonsOf.get(p.candidate) ?? []);
				return {
					kind: "claim",
					index: p.index,
					op: p.claim.op,
					status: "held",
					reasonCodes: own.length > 0 ? own : ["window_held"],
				};
			}),
		};
	}
	for (const verdict of second.value.verdicts)
		if (verdict.status === "rejected")
			rejections.set(verdict.index, [...verdict.reasonCodes]);
	for (const item of second.value.handoff)
		accepted.set(item.index, {
			...item.draft,
			lifecycle: "candidate",
			rootEvidenceIds: [
				...new Set(item.draft.evidence.map((e) => e.rootEvidenceId)),
			].sort(),
		} as Assertion);
	return { accepted, rejections };
}

export type Apply =
	| { how: "assert"; p: Planned; assertion: Assertion }
	| {
			how: "correct";
			p: Planned;
			assertion: Assertion;
			old: ProjectionEntry;
	  }
	| { how: "retract"; p: Planned; old: ProjectionEntry };

/** Host checks that need the validated draft: what is really going to be written. */
export function decide(
	plan: OutputPlan,
	validated: Validated,
	claims: readonly ProjectionEntry[],
	headOf: ReadonlyMap<string, ProjectionEntry>,
): Apply[] {
	const todo: Apply[] = [];
	const touched = new Set<string>();
	const drop = (p: Planned, op: Planned["claim"]["op"], ...why: string[]) =>
		plan.elements.push({
			kind: "claim",
			index: p.index,
			op,
			status: "dropped",
			reasonCodes: why,
		});
	for (const p of plan.planned) {
		const why =
			p.candidate === undefined
				? undefined
				: validated.rejections.get(p.candidate);
		if (why) {
			drop(p, p.claim.op, ...why);
			continue;
		}
		const assertion =
			p.candidate === undefined
				? undefined
				: validated.accepted.get(p.candidate);
		if (p.claim.op === "assert") {
			if (!assertion) {
				drop(p, "assert", "CANDIDATE_NOT_ACCEPTED");
				continue;
			}
			const duplicate = claims.some(
				(entry) =>
					entry.subjectId === assertion.subjectId &&
					entry.predicate === assertion.predicate &&
					entry.origin === assertion.origin &&
					canonical(entry.assertion.payload) === canonical(assertion.payload),
			);
			if (duplicate) {
				drop(p, "assert", "duplicate_claim");
				continue;
			}
			todo.push({ how: "assert", p, assertion });
			continue;
		}
		const old = headOf.get(p.target!.id);
		if (!old || old.revision !== p.target!.revision || touched.has(old.id)) {
			drop(p, p.claim.op, "claim_conflict");
			continue;
		}
		if (p.claim.op === "retract") {
			touched.add(old.id);
			todo.push({ how: "retract", p, old });
			continue;
		}
		if (
			!assertion ||
			assertion.subjectId !== old.subjectId ||
			assertion.predicate !== old.predicate
		) {
			drop(p, "correct", "correct_target_mismatch");
			continue;
		}
		touched.add(old.id);
		todo.push({ how: "correct", p, assertion, old });
	}
	return todo;
}

/**
 * A new entity is registered only for a claim that is going to be written: the ones no written
 * claim names as subject or relation object are dropped (`unused_entity`).
 */
export function dropUnusedEntities(plan: OutputPlan, todo: readonly Apply[]) {
	const used = new Set<string>();
	for (const t of todo) {
		if (t.how === "retract") continue;
		used.add(t.assertion.subjectId);
		const payload = t.assertion.payload as { objectId?: string };
		if (payload.objectId !== undefined) used.add(payload.objectId);
	}
	for (const [index, entity] of plan.newEntities) {
		if (used.has(entity.id)) continue;
		plan.newEntities.delete(index);
		plan.elements.push({
			kind: "entity",
			index,
			op: "register",
			status: "dropped",
			reasonCodes: ["unused_entity"],
		});
	}
}
