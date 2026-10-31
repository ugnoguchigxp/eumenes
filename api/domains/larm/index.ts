export type { ChatMessage, ChatImage, ChatInput } from "./contracts/chat-input";
export type {
	LarmPort,
	LarmExchange,
	LarmCallOptions,
	LarmStatus,
} from "./contracts";
export {
	intentLabels,
	type IntentInput,
	type IntentJudgment,
	type IntentLabel,
} from "./contracts/user-intent";
export { registerLarmStatus } from "./controller";
export { createLarm } from "./service";
export { createAgentLarm } from "./service/agent-connections";
export { createGenerationLanes } from "./service/generation-lanes";
export { createActivityRecorder } from "./service/activity";
export {
	createMonitoringClient,
	MONITORING_BODY_LIMIT,
	type MonitoringRead,
} from "./service/monitoring";
export type {
	ActivityObservation,
	ActivityRecorder,
} from "./contracts/activity";
export {
	createLarmPlayground,
	type LarmPlayground,
} from "./service/playground";
export type {
	LarmTestTarget,
	TestKind,
	TestOutput,
	TestHealth,
	TestProgress,
	TestArtifact,
} from "./contracts/playground";
export { findServiceTarget } from "./service/playground-select";
export {
	LARM_CAPACITY_BUSY,
	LARM_CAPACITY_RETRY_MS,
	LARM_CAPACITY_TIMEOUT,
	LARM_CAPACITY_WAITING,
	planCapacityWait,
	type CapacityWait,
} from "./contracts/capacity";
export {
	checkRefusal,
	isCapacityBusy,
	LarmCapacityBusy,
	retryAfter,
	sendAgainIfLost,
} from "./service/resend";
export { settleCapacityWait } from "./service/capacity-wait";
export { silentWav, code as playgroundError } from "./service/playground-http";

export { trackQuery, type TrackQuery } from "./contracts/music-library";
export { MusicLibraryError } from "./service/music-library";
export { ImageImportError } from "./service/image-import";
export { createLocalServices } from "./service/local-services";
export type {
	LocalServiceLease,
	LocalServicesPort,
} from "./contracts/local-services";

export { createComputeClient } from "./service/compute-client";

export { createVisualPerception } from "./service/visual-perception";
export type {
	PerceptionPort,
	/** @public */ PerceptionResult,
	/** @public */ PerceptionOptions,
	AnalysisRecord,
	AnalysisCreate,
} from "./contracts/visual-perception";

export { analysisCreate } from "./contracts/visual-perception";
