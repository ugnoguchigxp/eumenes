import { createExtractionCtx } from "./extraction-ctx";
import { createExtractionEvents } from "./extraction-events";
import { createExecute } from "./extraction-execute";
import { createPrepare } from "./extraction-prepare";
import { createSettle } from "./extraction-settle";
import {
	extractionPayloadSchema,
	type ExtractionHandler,
	type ExtractionOptions,
} from "./extraction-types";
import { WORLD_EXTRACT_KIND } from "./extraction-shared";
import type { ScopeRef } from "eumenes-world-model";

export {
	EXTRACT_CONFIRM_MS,
	EXTRACT_INTERPRETATION_VERSION,
	EXTRACT_STAGE_BUDGET_MS,
	FOREGROUND_ACTIVE,
	SLOT_BUSY,
	WORLD_EXTRACT_KIND,
	WORLD_EXTRACT_PURPOSE,
} from "./extraction-shared";
export { extractionPayloadSchema } from "./extraction-types";
export type {
	ExtractionHandler,
	ExtractionInference,
	ExtractionOptions,
	ExtractionOutput,
	ExtractionPayload,
	ExtractionPoint,
	ExtractionQueue,
	ExtractionReport,
	JobClaim,
	PreparedExtraction,
	SettleOutcome,
} from "./extraction-types";

/**
 * Local extraction (P4-02): a queue handler whose prepare fixes the input and
 * registers Memory's external dependents, whose execute asks ONLY the Local
 * model (never Cloud) under a 30 s stage budget, and whose settle re-checks
 * every candidate against the current source versions before `candidate.settle`.
 * The model never assigns ids, lifecycle or success: those are the host's.
 *
 * Local classification relied on: the request is captured through the
 * inference control path, which pins the route to `larm-only` with
 * `cloudAllowed=false` (the registered LARM section, not a LAN address); the
 * request snapshot is read back and refused unless it says so. The inference
 * service never starts a Cloud attempt for such a route.
 */
export function createWorldExtraction(options: ExtractionOptions) {
	const ctx = createExtractionCtx(options);
	const { store, slot, slotListeners } = ctx;
	const events = createExtractionEvents(ctx);
	const { scheduleInTransaction } = events;

	const handler: ExtractionHandler = {
		kind: WORLD_EXTRACT_KIND,
		payloadVersions: [1],
		schema: extractionPayloadSchema,
		recovery: "replay_safe",
		resourceKey: "inference.llm",
		...createPrepare(ctx, events),
		...createExecute(ctx),
		...createSettle(ctx, events),
	};

	return {
		handler,
		/** Schedules in the caller's writer callback (atomic with whatever made the input). */
		scheduleInTransaction,
		/** Own writer callback. No unsettled input: no job, no model request. */
		schedule: (scope: ScopeRef) =>
			store.write((db) => scheduleInTransaction(db, scope)),
		/**
		 * True while a model call this handler started has not REALLY ended
		 * (including one that was cancelled but never confirmed). No new call
		 * starts while it is true.
		 */
		slotBusy: (): boolean => slot.inFlight !== null,
		/** Told when such a call finally ended, so held input can be scheduled again. */
		onSlotFree(listener: () => void): () => void {
			slotListeners.add(listener);
			return () => {
				slotListeners.delete(listener);
			};
		},
	};
}
export type WorldExtraction = ReturnType<typeof createWorldExtraction>;
