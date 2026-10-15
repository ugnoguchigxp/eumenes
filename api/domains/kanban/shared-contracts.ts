/** Execution identity is a registry key, never a closed union of providers. */
export const DEFAULT_EXECUTOR_ID = "claude-code";
export type CommonRunState =
	| "queued"
	| "dispatched"
	| "running"
	| "waiting"
	| "settling"
	| "stopping"
	| "completed"
	| "blocked"
	| "cancelled"
	| "unknown";
export const ACTIVE_RUN_STATES: readonly CommonRunState[] = [
	"dispatched",
	"running",
	"waiting",
	"settling",
	"stopping",
];
export const OPEN_RUN_STATES: readonly CommonRunState[] = [
	"queued",
	...ACTIVE_RUN_STATES,
];
export type KanbanExecutor = {
	id: string;
	revision: number;
	label: string;
	available: boolean;
	unavailableReason?: string;
	/** Host registration decides the workspace; requests never supply filesystem paths. */
	workspaceRef: string;
	sessionPolicy: "host-created" | "executor-created";
	capabilities: {
		terminal: boolean;
		activity: boolean;
		commit: boolean;
		push: boolean;
		commitPush: boolean;
	};
};
export const LEGACY_EXECUTOR: KanbanExecutor = {
	id: DEFAULT_EXECUTOR_ID,
	revision: 1,
	label: "Claude Code",
	available: true,
	workspaceRef: "eumenes",
	sessionPolicy: "host-created",
	capabilities: {
		terminal: true,
		activity: true,
		commit: false,
		push: false,
		commitPush: true,
	},
};
export type ExecutorRegistry = () => readonly KanbanExecutor[];
