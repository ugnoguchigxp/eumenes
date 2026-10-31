export {
	SourceCursorError,
	NO_INTAKE_PORTS,
	WORLD_CURATE_PURPOSE,
	createWorldCuration,
	curationOutputShapeSchema,
	createConversationSourceAdapter,
	createWorldContextNames,
	MIN_NAME_CHARS,
	normalizeTopicText,
	createWorldHostGate,
	createWorldLifecycle,
	createWorldService,
	createWorldClaims,
	conditionText,
	createWorldQuery,

	/** @public */ sourceKeyOf,
	worldHasContent,
} from "./service";
export type {

	/** @public */ CurationElement,

	/** @public */ CurationPrepareResult,
	/** @public */ CurationSettleResult,
	IntakePorts,
	PendingCurationEvent,
	PreparedCuration,
	WorldCuration,
	ConsumeReport,
	LifecycleOptions,
	RecoverReport,
	WorldHostGate,
	WorldLifecycle,
	WorldClaims,
	WorldClaimsContext,
	WorldService,
} from "./service";
export { migrations } from "./repository/migrations";
export type {
	WorldQueryContext,
	WorldQueryResult,

	/** @public */ WorldApplyRequest,
	WorldStatus,
} from "./contracts";

export { createWorldDocuments, type WorldDocuments } from "./service/documents";
export { registerWorldDocuments } from "./controller/documents";
