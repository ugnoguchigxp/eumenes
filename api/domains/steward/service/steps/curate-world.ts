import {
	curationOutputShapeSchema,
	type PreparedCuration,
} from "../../../world";
import { MAX_FAILURES } from "../../contracts";
import {
	bumpWorldEvent,
	deleteRoutesOfMessages,
	deleteWorldEvents,
} from "../../repository";
import { localDay, isRecord } from "../context";
import { instructions } from "../prompts/curate-world";
import { curateWorldSchema } from "../schemas";
import type {
	ApplyResult,
	PrepareResult,
	StepDefinition,
	StepEnv,
} from "../types";

/**
 * curate-world (T5): the steward's model call over the events World received. The window is one run (at most
 * two events: the user's message and the adopted answer); the World package closes every claim over ALL the
 * window's messages (each becomes the claim's manifest), so a small window keeps that closure small.
 * World owns what the model may see (`prepareCurationInTransaction`) and what of its answer is accepted
 * (`settleCurationInTransaction`); this step only carries the data between them.
 */
type WorldContext = { prepared: PreparedCuration };

type CurateWorldOutput = {
	entities: unknown[];
	claims: unknown[];
	changed: boolean;
};

function prepare(
	env: StepEnv,
	unit: { targets: { events?: string[] } },
): PrepareResult {
	const world = env.deps.world;
	if (!world) return { status: "stale", reason: "world_off" };
	const result = world.curation.prepareCurationInTransaction(env.db, {
		scope: world.scope,
		eventIds: unit.targets.events ?? [],
	});
	// Events World closed for good while preparing are final: nothing of them is counted any more.
	deleteWorldEvents(
		env.db,
		result.finalized.map((f) => f.eventId),
	);
	if (result.status !== "ready")
		return {
			status: "stale",
			reason: result.reason,
			...(result.status === "not_ready" ? { retryLater: true } : {}),
		};
	const { prepared } = result;
	return {
		status: "ready",
		data: {
			today: localDay(env.deps.nowMs()),
			utterances: prepared.model.utterances,
			entities: prepared.model.entities,
			claims: prepared.model.claims,
		},
		targets: { events: prepared.eventIds },
		context: { prepared } satisfies WorldContext,
	};
}

/** The model writes a value flat (strict schemas have no unions); World reads it as its typed value. */
function typedValue(value: unknown): unknown {
	if (!isRecord(value)) return null;
	if (value.type === "string" && typeof value.text === "string")
		return { type: "string", value: value.text };
	if (value.type === "boolean" && typeof value.flag === "boolean")
		return { type: "boolean", value: value.flag };
	if (
		value.type === "number" &&
		typeof value.number === "number" &&
		typeof value.unit === "string"
	)
		return { type: "number", value: value.number, unit: value.unit };
	return null;
}

function parse(raw: unknown): CurateWorldOutput | null {
	if (!isRecord(raw)) return null;
	const shape = curationOutputShapeSchema.safeParse({
		...raw,
		claims: Array.isArray(raw.claims)
			? raw.claims.map((claim) =>
					isRecord(claim)
						? { ...claim, value: typedValue(claim.value) }
						: claim,
				)
			: raw.claims,
	});
	if (!shape.success) return null;
	return {
		entities: shape.data.entities,
		claims: shape.data.claims,
		changed: shape.data.changed === true,
	};
}

const none = (over: Partial<ApplyResult>): ApplyResult => ({
	applied: 0,
	rejected: 0,
	output: null,
	results: [],
	refs: [],
	notices: [],
	changed: false,
	...over,
});

function apply(
	env: StepEnv,
	prepared: { context: unknown },
	raw: unknown,
): ApplyResult {
	const { db, deps } = env;
	const world = deps.world!;
	const { prepared: window } = prepared.context as WorldContext;
	const output = raw as CurateWorldOutput;
	const eventIds = window.host.events.map((e) => e.eventId);
	// F6: a World forget since prepare voids the result (the memory fence `forget_seq` is checked by the unit).
	if (
		world.curation.forgetEpochInTransaction(db, window.scope) !==
		window.host.forgetEpoch
	)
		return none({ stale: "world_forget_epoch_changed" });
	const messageRefs = window.host.events.map((e) => ({
		type: "message" as const,
		id: e.messageId,
	}));
	const settled = world.curation.settleCurationInTransaction(db, {
		prepared: window,
		output,
	});
	switch (settled.status) {
		case "invalid_output":
			return none({ unusable: true });
		case "stale":
			return none({ stale: `world_${settled.reason}` });
		case "held": {
			// The window waits for the entities to change; the third time the events are given up (they do not block later ones).
			const exhausted = eventIds.filter(
				(id) => bumpWorldEvent(db, id, "holds") >= MAX_FAILURES,
			);
			if (exhausted.length > 0) {
				world.curation.giveUpEventsInTransaction(db, window.scope, exhausted);
				deleteWorldEvents(db, exhausted);
			}
			return none({
				rejected: settled.elements.length,
				output,
				results: [
					...settled.elements.map(describe),
					{
						status: "held",
						reasonCodes: settled.reasonCodes,
						...(exhausted.length > 0 ? { gaveUp: exhausted.length } : {}),
					},
				],
				refs: messageRefs,
			});
		}
		case "settled": {
			deleteWorldEvents(db, settled.eventIds);
			deleteRoutesOfMessages(
				db,
				window.host.events.map((e) => e.messageId),
			);
			return none({
				applied: settled.elements.filter((e) => e.status === "applied").length,
				rejected: settled.elements.filter((e) => e.status !== "applied").length,
				output,
				results: settled.elements.map(describe),
				refs: [
					...messageRefs,
					...settled.touched.messageIds.map((id) => ({
						type: "message" as const,
						id,
					})),
					...settled.touched.claimIds.map((id) => ({
						type: "claim" as const,
						id,
					})),
					...settled.touched.entityIds.map((id) => ({
						type: "entity" as const,
						id,
					})),
				],
			});
		}
	}
}

/** One element of the settle as the decision record keeps it: status and codes, never text. */
function describe(element: {
	kind: string;
	index: number;
	op: string;
	status: string;
	reasonCodes: string[];
	outcome?: string | undefined;
	claimId?: string | undefined;
	entityId?: string | undefined;
}) {
	return {
		kind: element.kind,
		index: element.index,
		op: element.op,
		status: element.status,
		...(element.reasonCodes.length > 0 ? { codes: element.reasonCodes } : {}),
		...(element.outcome ? { outcome: element.outcome } : {}),
		...(element.claimId ? { claimId: element.claimId } : {}),
		...(element.entityId ? { entityId: element.entityId } : {}),
	};
}

export const curateWorld: StepDefinition = {
	id: "curate-world",
	slot: "world",
	// World is long-term knowledge: it is written one unit at a time, like the long-term memory.
	longTerm: true,
	instructions,
	outputSchema: () => curateWorldSchema,
	prepare: (env, unit) => prepare(env, unit),
	parse,
	apply: (env, prepared, output) => apply(env, prepared, output),
};
