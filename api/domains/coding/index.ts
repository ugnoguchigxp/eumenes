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
export type { SdkGitRemote } from "../../../packages/coding-runner/src/contracts";

export type {
	ClaudeObservation,
	ClaudeStart,
	ClaudeEvidence,
	ClaudeRunAuthorization,
	ClaudeLease,
	ClaudeQuestion,
	ClaudeEventsResponse,
	ClaudeDaemonConfig,
} from "../../../packages/coding-runner/src/contracts";
export { claudeAuthorization } from "../../../packages/coding-runner/src/contracts";
export { claudeInputDigest } from "../../../packages/coding-runner/src/contracts";
export {
	claudeRunnerClient,
	claudeDaemonClient,
} from "../../../packages/coding-runner/src/client";
