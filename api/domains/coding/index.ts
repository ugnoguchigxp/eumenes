export {
	createCoding,
	type CodingService,
	type CodingAuthority,
	observationIssueCode,
} from "./service";
export type { ObservationSnapshot } from "./contracts";
export { registerCoding } from "./controller";
export { migration, migrations } from "./repository";
export { connectRunner } from "./adapters";
/** Independent SDK runner protocol: mechanics only, no task/board policy. */
export {
	sdkId,
	sdkSpecSchema,
	sdkTerminal,
} from "../../../packages/coding-runner/src/contracts";
export type {
	SdkSpec,
	SdkState,
	SdkReceipt,
	SdkActivity,
} from "../../../packages/coding-runner/src/contracts";
export { sdkEventsSchema } from "../../../packages/coding-runner/src/contracts";
export { sdkRunnerClient } from "../../../packages/coding-runner/src/client";
export { canonicalJSON as codingCanonicalJSON } from "../../../packages/coding-runner/src/contracts";

export { sdkDaemonClient } from "../../../packages/coding-runner/src/client";

export { registeredSdkGitRemotes } from "../../../packages/coding-runner/src/client";
export type {
	SdkGitRemote,
	SdkGitResult,
	SdkSnapshot,
} from "../../../packages/coding-runner/src/contracts";
