import { join } from "node:path";
import {
	legacyProtocolVersion,
	storedSpecSchema,
	type ExecutionReceipt,
	type ExecutionSpec,
} from "./contracts";
import type { RunnerConfig } from "./config";
import { canonical, optionalJson, readPrivate, runPath } from "./storage";

/** A session may continue only from a stopped, normally finished, fully captured v2 turn. */
export function assertContinuable(
	config: RunnerConfig,
	spec: ExecutionSpec,
	previous: ExecutionReceipt,
) {
	const path = runPath(config.spoolRoot, previous.executionId);
	const oldSpec = storedSpecSchema.parse(
		JSON.parse(readPrivate(join(path, "spec.json"))),
	);
	// v1 sessions are readable and stoppable, but their turn evidence is not continued.
	if (oldSpec.version === legacyProtocolVersion)
		throw new Error("coding_legacy_continue_unsupported");
	if (
		!previous.childrenStopped ||
		!previous.turnFinished ||
		previous.observation.turnOutcome !== "completed" ||
		!previous.evidenceComplete ||
		(previous.state === "exited" && previous.exitCode !== 0) ||
		!["exited", "stopped"].includes(previous.state) ||
		previous.sessionId !== spec.sessionId ||
		oldSpec.taskId !== spec.taskId ||
		oldSpec.workspaceId !== spec.workspaceId ||
		oldSpec.generation !== spec.generation ||
		oldSpec.authorityEpoch !== spec.authorityEpoch ||
		oldSpec.network !== spec.network ||
		canonical([...oldSpec.operations].sort()) !==
			canonical([...spec.operations].sort()) ||
		spec.deadlineAt > oldSpec.deadlineAt
	)
		throw new Error("runner_session_busy_or_stale");
	const stop = optionalJson<{ reason: string }>(join(path, "stop.json"));
	if (stop && stop.reason !== "pause")
		throw new Error("runner_session_revoked");
}
