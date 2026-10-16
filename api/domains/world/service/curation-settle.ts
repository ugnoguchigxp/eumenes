import type { Database } from "bun:sqlite";
import type { Adoption } from "./curation-adopt";
import type { CurationCtx } from "./curation-ctx";
import { curationOutputShapeSchema } from "./curation-output";
import { planOutput, verifyWorld } from "./curation-plan";
import { decide, dropUnusedEntities, validate } from "./curation-validate";
import { write } from "./curation-write";
import type { CurationSettleResult, PreparedCuration } from "./curation-types";

/**
 * The model's answer becomes World: re-verified, judged element by element by the host,
 * validated by the package, placed event by event and adopted. Everything happens in the
 * caller's transaction; anything but `settled` has written nothing.
 */
export function createSettle(ctx: CurationCtx, adoption: Adoption) {
	return function settleCurationInTransaction(
		db: Database,
		input: { prepared: PreparedCuration; output: unknown },
	): CurationSettleResult {
		const { prepared } = input;
		const { scope, host } = prepared;
		const eventIds = host.events.map((e) => e.eventId);
		const verified = verifyWorld(ctx, db, prepared);
		if (typeof verified === "string") {
			ctx.releaseEvents(db, scope, eventIds);
			return { status: "stale", reason: verified };
		}
		const shape = curationOutputShapeSchema.safeParse(input.output);
		if (!shape.success) {
			ctx.releaseEvents(db, scope, eventIds);
			return { status: "invalid_output", reason: "OUTPUT_SHAPE" };
		}
		const plan = planOutput(prepared, shape.data, verified.states);
		const validated = validate(ctx, db, prepared, plan, verified.states);
		if ("status" in validated) return validated;
		const todo = decide(plan, validated, verified.claims, verified.headOf);
		dropUnusedEntities(plan, todo);
		return write(ctx, adoption, db, prepared, verified.rows, plan, todo);
	};
}
