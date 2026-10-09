import type { SourceRef } from "eumenes-memory";
import {
	NOW,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	currentRef,
	registerClaim,
	request,
	type Harness,
} from "./fixture";

export const yes = (id: string) => ({
	kind: "explicitly_unconditional",
	adoptionEvidenceId: `ev-${id}-0`,
});

export type RelationOptions = {
	condition?: unknown;
	adopt?: boolean;
};

/** One relation claim from a confirmed message, adopted unless told otherwise. */
export async function relate(
	h: Harness,
	ref: SourceRef,
	id: string,
	from: string,
	to: string,
	relation: string,
	options: RelationOptions = {},
): Promise<void> {
	const registered = await h.world.apply(
		registerClaim(
			`c-${id}`,
			claim(id, [ref], {
				subjectId: from,
				predicate: relation,
				payload: { kind: "relation", relation, objectId: to },
				condition: options.condition ?? yes(id),
			}),
		),
	);
	if (registered.status !== "applied")
		throw new Error(`relate ${id}: ${JSON.stringify(registered)}`);
	if (options.adopt === false) return;
	const adopted = await h.world.apply(
		request(`ad-${id}`, {
			kind: "assertion.transition",
			plan: adoptPlan(id, 1),
		}),
	);
	if (adopted.status !== "applied")
		throw new Error(`adopt ${id}: ${JSON.stringify(adopted)}`);
}

/** A message plus its current ref: every claim of a test stands on it. */
export async function messageRef(h: Harness, id = "m1"): Promise<SourceRef> {
	await addMessage(h, id, "AはBを引き起こし、BはCを引き起こす。");
	return currentRef(h, id);
}

export { NOW, SCOPE };
