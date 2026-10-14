import type { Database } from "bun:sqlite";
import type { SourceState } from "eumenes-memory";
import type { Entity, ProjectionEntry } from "eumenes-world-model";
import { utf8Length, type CurationCtx } from "./curation-ctx";
import { named, groundingForm } from "./curation-grounding";
import { parseClaim, parseEntity, validTimeOf } from "./curation-output";
import {
	CURATION_LIMITS,
	type CurationElement,
	type CurationHostEvent,
	type CurationOutputClaim,
	type CurationSettleResult,
	type CurationSpeaker,
	type PreparedCuration,
} from "./curation-types";
import type { ExtractEventRow } from "../repository/extraction";

/** The origin a claim may carry, by who spoke: a person reports, an answer only hypothesises. */
const originOf = (speaker: CurationSpeaker) =>
	speaker === "user" ? ("user_report" as const) : ("model_hypothesis" as const);

const WORD_REF = /^w\d+$/;
const NEW_REF = /^new:(\d+)$/;

type SubjectQuery =
	| { kind: "id"; id: string }
	| { kind: "alias"; text: string };

export type Planned = {
	/** Position in the output's `claims`. */
	index: number;
	claim: CurationOutputClaim;
	event: CurationHostEvent;
	/** The claim a `correct` or `retract` changes. */
	target?: PreparedCuration["host"]["claims"][number];
	/** Index among the candidates handed to the validator (assert and correct). */
	candidate?: number;
};

export type StaleReason = Extract<
	CurationSettleResult,
	{ status: "stale" }
>["reason"];

export type Verified = {
	rows: ExtractEventRow[];
	states: Map<string, SourceState>;
	claims: readonly ProjectionEntry[];
	headOf: Map<string, ProjectionEntry>;
};

/** The world must be what it was when the model was asked: a reason when it is not. */
export function verifyWorld(
	ctx: CurationCtx,
	db: Database,
	prepared: PreparedCuration,
): Verified | StaleReason {
	const { scope, host } = prepared;
	if (ctx.unusable(db)) return "world_unavailable";
	if (ctx.world.forgetEpoch(db, scope) !== host.forgetEpoch)
		return "forget_epoch_changed";
	const found = host.events.map((e) => ctx.receivedEvent(db, scope, e.eventId));
	const rows = found.flatMap((row) => (row === null ? [] : [row]));
	if (rows.length !== found.length) return "input_changed";
	const blocked = ctx.intake.blockedMessageIds(
		db,
		host.events.map((e) => e.messageId),
	);
	const states = new Map<string, SourceState>();
	for (const [index, row] of rows.entries()) {
		const verdict = ctx.classify(db, scope, row, blocked);
		if (verdict.kind === "final")
			return verdict.reason === "SOURCE_BLOCKED"
				? "source_blocked"
				: "input_version_changed";
		const was = host.events[index]!;
		if (
			verdict.live.ref.revision !== was.source.revision ||
			verdict.live.ref.digest !== was.source.digest
		)
			return "input_version_changed";
		states.set(was.eventId, verdict.live.state);
	}
	const current = ctx.entitiesByIds(
		db,
		scope,
		host.entities.map((e) => e.id),
	);
	if (current === null) return "world_unavailable";
	const revisions = new Map(current.map((e) => [e.id, e.revision]));
	if (host.entities.some((e) => revisions.get(e.id) !== e.revision))
		return "entities_changed";
	const live = ctx.liveClaims(db, scope);
	if (live === null) return "world_unavailable";
	return {
		rows,
		states,
		claims: live.entries,
		headOf: new Map(live.entries.map((entry) => [entry.id, entry])),
	};
}

export type OutputPlan = {
	elements: CurationElement[];
	newEntities: Map<number, Entity>;
	planned: Planned[];
	/** What the package validates: one candidate per planned assert or correct. */
	candidates: Record<string, unknown>[];
};

/** Judges each element of the answer on its own; nothing is written. */
export function planOutput(
	prepared: PreparedCuration,
	shape: { entities: unknown[]; claims: unknown[] },
	states: ReadonlyMap<string, SourceState>,
): OutputPlan {
	const { scope, host } = prepared;
	const elements: CurationElement[] = [];
	const dropEntity = (index: number, ...reasonCodes: string[]) =>
		elements.push({
			kind: "entity",
			index,
			op: "register",
			status: "dropped",
			reasonCodes,
		});
	const newEntities = new Map<number, Entity>();
	shape.entities.forEach((raw, index) => {
		if (index >= CURATION_LIMITS.newEntities)
			return dropEntity(index, "entity_overflow");
		const parsed = parseEntity(raw);
		if (parsed === null) return dropEntity(index, "invalid_element");
		newEntities.set(index, {
			id: `we-${host.windowId}-${index}`,
			scope,
			revision: 1,
			displayName: parsed.name,
			aliases: [parsed.name, ...parsed.aliases],
			externalRefs: [],
		});
	});

	const planned: Planned[] = [];
	const dropClaim = (
		index: number,
		op: CurationOutputClaim["op"],
		...reasonCodes: string[]
	) =>
		elements.push({ kind: "claim", index, op, status: "dropped", reasonCodes });
	const queryOf = (text: string): SubjectQuery | null => {
		if (WORD_REF.test(text)) {
			const found = host.entities.find((e) => e.ref === text);
			return found ? { kind: "id", id: found.id } : null;
		}
		const created = NEW_REF.exec(text);
		if (created) {
			const entity = newEntities.get(Number(created[1]));
			return entity ? { kind: "id", id: entity.id } : null;
		}
		return { kind: "alias", text: text.normalize("NFC") };
	};
	/** The names a subject or object text stands for; null when it names nothing known. */
	const namesOfId = (id: string): readonly string[] => {
		const entity = host.entitySnapshot.find((e) => e.id === id);
		return entity ? [entity.displayName, ...entity.aliases] : [];
	};
	const namesOf = (text: string): readonly string[] | null => {
		if (WORD_REF.test(text)) {
			const id = host.entities.find((e) => e.ref === text)?.id;
			return id === undefined ? null : namesOfId(id);
		}
		const created = NEW_REF.exec(text);
		if (created) {
			const entity = newEntities.get(Number(created[1]));
			return entity ? entity.aliases : null;
		}
		// A plain name: the words as written, and every shown entity that goes by them.
		const wanted = groundingForm(text);
		return [
			text,
			...host.entitySnapshot
				.filter((e) =>
					[e.displayName, ...e.aliases].some(
						(n) => groundingForm(n) === wanted,
					),
				)
				.flatMap((e) => [e.displayName, ...e.aliases]),
		];
	};
	const contentOf = (event: CurationHostEvent) =>
		states.get(event.eventId)?.content ?? "";
	const candidates: Record<string, unknown>[] = [];
	const candidateOf = (
		claim: CurationOutputClaim,
		event: CurationHostEvent,
		subject: SubjectQuery,
		object: SubjectQuery | undefined,
		time: Exclude<ReturnType<typeof validTimeOf>, null>,
	): Record<string, unknown> => ({
		subject,
		predicate: claim.predicate,
		payload:
			claim.value !== null
				? {
						kind: "value",
						value:
							claim.value.type === "number"
								? {
										kind: "number",
										value: claim.value.value,
										unit: claim.value.unit,
									}
								: { kind: claim.value.type, value: claim.value.value },
					}
				: { kind: "relation", relation: claim.relation!.kind, object },
		quote: {
			utteranceId: event.eventId,
			startByte: 0,
			endByte: utf8Length(contentOf(event)),
		},
		modality: event.speaker === "user" ? "asserted" : "reported",
		...(time === undefined ? {} : { validTime: time }),
	});
	shape.claims.forEach((raw, index) => {
		if (index >= CURATION_LIMITS.outputClaims)
			return dropClaim(index, "assert", "CANDIDATE_OVERFLOW");
		const claim = parseClaim(raw);
		if (claim === null) return dropClaim(index, "assert", "invalid_element");
		const event = host.events.find((e) => e.label === claim.evidence);
		if (!event) return dropClaim(index, claim.op, "unknown_evidence");
		// The speaker decides the origin: nobody's answer is the person's report.
		if (claim.origin !== originOf(event.speaker))
			return dropClaim(index, claim.op, "origin_mismatch");
		let target: Planned["target"];
		if (claim.op !== "assert") {
			target = host.claims.find((c) => c.ref === claim.ref);
			if (!target) return dropClaim(index, claim.op, "unknown_ref");
		}
		const utterance = contentOf(event);
		if (claim.op === "retract") {
			// A denial is the person's to make; an answer may never take a claim back.
			if (claim.origin !== "user_report")
				return dropClaim(index, claim.op, "retract_requires_user_report");
			if (!named(utterance, namesOfId(target!.subjectId)))
				return dropClaim(index, claim.op, "not_in_evidence");
			planned.push({ index, claim, event, target });
			return;
		}
		if (claim.op === "correct") {
			// A correction states a new value: only the person's own words may do that.
			if (claim.origin !== "user_report")
				return dropClaim(index, claim.op, "correct_requires_user_report");
			if (!named(utterance, namesOfId(target!.subjectId)))
				return dropClaim(index, claim.op, "not_in_evidence");
		}
		if (
			claim.subject === null ||
			claim.predicate === null ||
			(claim.value === null) === (claim.relation === null) ||
			(claim.op === "correct" &&
				(claim.value === null) === (target!.kind === "value"))
		)
			return dropClaim(index, claim.op, "invalid_element");
		const time = validTimeOf(claim.validFrom, claim.validUntil);
		if (time === null) return dropClaim(index, claim.op, "invalid_valid_time");
		const subject = queryOf(claim.subject);
		const object =
			claim.relation === null ? undefined : queryOf(claim.relation.object);
		if (subject === null || object === null)
			return dropClaim(index, claim.op, "unknown_ref");
		// Every entity the claim is about must be named in the words it stands on.
		const about = [
			claim.subject,
			...(claim.relation ? [claim.relation.object] : []),
		];
		if (about.some((text) => !named(utterance, namesOf(text) ?? [])))
			return dropClaim(index, claim.op, "not_in_evidence");
		if (claim.op === "correct" && target!.kind === "relation") {
			// A relation has no value to change: the person's words retract it and state the new one.
			if (
				subject.kind !== "id" ||
				subject.id !== target!.subjectId ||
				claim.predicate !== target!.predicate
			)
				return dropClaim(index, claim.op, "correct_target_mismatch");
			planned.push({
				index,
				claim: { ...claim, op: "retract" },
				event,
				target,
			});
			planned.push({
				index,
				claim: { ...claim, op: "assert", ref: null },
				event,
				candidate: candidates.length,
			});
			candidates.push(candidateOf(claim, event, subject, object, time));
			return;
		}
		planned.push({ index, claim, event, target, candidate: candidates.length });
		candidates.push(candidateOf(claim, event, subject, object, time));
	});

	// A name nobody said is not registered: an entity must occur in the window it came from.
	const said = host.events.map(contentOf);
	for (const [index, entity] of newEntities) {
		if (said.some((text) => named(text, entity.aliases))) continue;
		newEntities.delete(index);
		dropEntity(index, "not_in_evidence");
	}
	return { elements, newEntities, planned, candidates };
}
