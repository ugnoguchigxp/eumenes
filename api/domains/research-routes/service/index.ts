import type { HandlerDefinition } from "../../queue";
import { type PlansOptions, createPlans } from "./plans";
import {
	type FlowDeps,
	type SourceAdoptionPort,
	type MaintenanceInference,
	type QueueSlice,
	type LearningCapabilities,
} from "./flow";
import { systemClock } from "./registry";
import { createRegistration } from "./registration";
import { createAuthorHandler } from "./authoring";
import { createReviewHandler } from "./reviewing";
import { type PruneLearned, createMaintenance } from "./maintenance";

export type LearningDeps = {
	queue: QueueSlice;
	capabilities: LearningCapabilities;
	inference: MaintenanceInference;
	adoption: SourceAdoptionPort;
};
export type ResearchRoutesOptions = PlansOptions & {
	learning?: LearningDeps;
	/** capabilities pruneLearnedInTransaction, used by sweep (same writer transaction). */
	prune?: PruneLearned;
	/** Queue for hourly / post-clear reclaim jobs; defaults to learning.queue. */
	queue?: QueueSlice;
	/** Protected bindings for reclaim when learning deps are not supplied. */
	adoption?: Pick<SourceAdoptionPort, "protectedBindingsInTransaction">;
};
/**
 * Public research-routes service. Later tasks (T20 API, T21 lifecycle) spread their operations into
 * the returned object. Without `learning` deps, registration operations skip with learning_unavailable.
 */
export function createResearchRoutes(opts: ResearchRoutesOptions = {}) {
	const clock = opts.clock ?? systemClock;
	const plans = createPlans(opts);
	const flow: Partial<FlowDeps> & { clock: typeof clock } = {
		clock,
		externalBytes:
			opts.externalBytes ??
			((db) =>
				opts.learning?.capabilities.learnedUsageInTransaction(db).bytes ?? 0),
		...opts.learning,
	};
	const registration = createRegistration({ ...flow, plans });
	/** Handlers for the Queue; register both before the runner starts. Requires `learning` deps. */
	function handlers(): HandlerDefinition<any, any, any>[] {
		if (!opts.learning) throw new Error("learning_unavailable");
		const deps = flow as FlowDeps;
		return [createAuthorHandler(deps), createReviewHandler(deps, registration)];
	}
	const maintenance = createMaintenance({
		clock,
		externalBytes: opts.externalBytes,
		prune: opts.prune,
		adoption: opts.learning?.adoption ?? opts.adoption,
		queue: opts.learning?.queue ?? opts.queue,
	});
	return { ...plans, ...registration, ...maintenance, handlers };
}
export type ResearchRoutes = ReturnType<typeof createResearchRoutes>;
export {
	deriveState,
	fenceOf,
	liveKey,
	stateTokenOf,
	systemClock,
	type Clock,
} from "./registry";
export type {
	ControlResult,
	StoreCandidatesInput,
	StoreCandidatesResult,
	UseResult,
	FailureResult,
} from "./plans";
export type {
	ObservationInput,
	AdoptedInput,
	AdoptedResult,
	EditInput,
	EditResult,
	ActivateInput,
	ActivateResult,
	FailureKind,
	RouteFailureResult,
} from "./registration";
export type {
	SourceAdoptionPort,
	SourceAdoptionDecision,
	MaintenanceInference,
	QueueSlice,
	LearningCapabilities,
} from "./flow";
export { validateRegistrationScenarios } from "./assets";
export { buildSearchSpec, bindRequest, renderKeywords, specKey } from "./keys";
export { checkObservation } from "./validation";
export {
	renderProjection,
	renderContext,
	projectionDigest,
} from "./projection";
export type {
	PruneLearned,
	MaintenanceOptions,
	SweepMode,
	SweepResult,
} from "./maintenance";
export {
	createOperations,
	type ApiResult,
	type OperationsDeps,
	type RouteChange,
	type RouteOperations,
	type SkillReader,
} from "./operations";
