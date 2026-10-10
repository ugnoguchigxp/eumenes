import type { SqliteStore } from "../../../infrastructure/sqlite";
import { toErrorCode } from "../../../infrastructure/error-code";
import type { getLogger } from "../../../infrastructure/logger";
import type { Capabilities, Prepared, Owner } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task } from "../contracts";
import type { EvidenceCatalog } from "./evidence-catalog";

export const STEP_KIND = "agent.step";
export const terminal = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);
export const active = (t: Task | null): t is Task =>
	!!t && !terminal.has(t.state);
export const owner = (t: Task): Owner => ({
	rootRunId: t.root_run_id,
	taskId: t.id,
	cancelEpoch: t.cancel_epoch,
});
export const failureCode = (error: unknown) =>
	toErrorCode(error, "reconcile_failed");

/** Collaborators handed to `createAgentRuntime`; shared read-only by every part. */
type RuntimeDeps = {
	store: SqliteStore;
	capabilities: Capabilities;
	tools: ToolRuntime;
	inference: InferencePort;
	queue: QueueService;
	now: () => number;
	/** Minimum gap between the end of one reconcile pass and the start of a commit-triggered one. */
	reconcileThrottleMs: number;
	/** Injected only by tests so the throttle never waits in real time. */
	timers: {
		setTimeout: typeof setTimeout;
		clearTimeout: typeof clearTimeout;
	};
	log: ReturnType<typeof getLogger>;
};

/** The runtime's only mutable state; created once per `createAgentRuntime`. */
export type RuntimeState = {
	traceIds: Set<string>;
	traced: Map<string, string>;
	prepared: Map<string, Prepared>;
	catalogs: Map<string, EvidenceCatalog>;
	actionPrepared: Map<string, Prepared>;
	bindings: Map<string, ReturnType<ToolRuntime["bind"]>>;
	/** key: "task:<id>" | "inv:<id>" */
	reconcileFailures: Map<string, number>;
	abortJobs: Set<string>;
	abortRequests: Set<string>;
	releases: Set<string>;
	closed: boolean;
	started: boolean;
	dirty: boolean;
	reconciling: Promise<void> | null;
	consecutiveFailedPasses: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	timer: ReturnType<typeof setTimeout> | null;
	maintaining: Promise<void> | null;
	maintenanceTimer: ReturnType<typeof setInterval> | null;
	lastPassEnded: number;
	throttleTimer: ReturnType<typeof setTimeout> | null;
};

export function createRuntimeState(): RuntimeState {
	return {
		traceIds: new Set(),
		traced: new Map(),
		prepared: new Map(),
		catalogs: new Map(),
		actionPrepared: new Map(),
		bindings: new Map(),
		reconcileFailures: new Map(),
		abortJobs: new Set(),
		abortRequests: new Set(),
		releases: new Set(),
		closed: false,
		started: false,
		dirty: false,
		reconciling: null,
		consecutiveFailedPasses: 0,
		retryTimer: null,
		timer: null,
		maintaining: null,
		maintenanceTimer: null,
		lastPassEnded: -Infinity,
		throttleTimer: null,
	};
}

export type RuntimeContext = { state: RuntimeState; deps: RuntimeDeps };
