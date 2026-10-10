/**
 * What the generic runtimes may know about a tool or package, keyed by definition id.
 * Host-owned and read through `toolRuntimeOf` / `packageRuntimeOf`: it is deliberately
 * neither stored in nor hashed into a capability revision, so stored revisions and their
 * digests stay valid. The agent-runtime and tool-runtime read this instead of comparing
 * tool ids.
 */
export type ToolRuntimeMeta = {
	/**
	 * search: external search; read: external read; saved_read: read of a body saved earlier;
	 * history: read of the conversation history; local_action: host action (no network).
	 */
	operation: "search" | "read" | "saved_read" | "history" | "local_action";
	/**
	 * The tool takes a URL that must be one the user gave or an earlier observation returned.
	 * Tools with a scope are page reads: they use the per-task read budget, other reads allow one call.
	 */
	urlScope?: "request_or_observed";
	/** Only offered once an earlier result left a saved body to read. */
	requiresSavedBody?: boolean;
	/** Cursor-paged search: repeated stale cursors end the task instead of retrying. */
	cursorPaging?: boolean;
	localAction?: { backend: "timer"; verb: "start" | "cancel" | "list" };
};
export type PackageRuntimeMeta = {
	/** quick: the small web budget (one search, one read, fewer model calls). */
	budget: "quick";
};

const tools: Readonly<Record<string, ToolRuntimeMeta>> = {
	"web.lookup": { operation: "search" },
	"web.read": { operation: "read", urlScope: "request_or_observed" },
	"web.forecast": { operation: "read" },
	"web.quote": { operation: "read" },
	"web.find": { operation: "saved_read", requiresSavedBody: true },
	"web.read_saved": { operation: "saved_read", requiresSavedBody: true },
	"history.search": { operation: "history", cursorPaging: true },
	"history.read": { operation: "history" },
	"timer.start": {
		operation: "local_action",
		localAction: { backend: "timer", verb: "start" },
	},
	"timer.cancel": {
		operation: "local_action",
		localAction: { backend: "timer", verb: "cancel" },
	},
	"timer.list": {
		operation: "local_action",
		localAction: { backend: "timer", verb: "list" },
	},
};
const packages: Readonly<Record<string, PackageRuntimeMeta>> = {
	"web.quick": { budget: "quick" },
};
const toolRevisionPattern = /^tool:([^@]+)@\d+$/;
/** Metadata of the tool a revision id (`tool:<id>@<n>`) names; undefined for unknown tools. */
export function toolRuntimeOf(revisionId: string): ToolRuntimeMeta | undefined {
	const id = toolRevisionPattern.exec(revisionId)?.[1];
	return id && Object.hasOwn(tools, id) ? tools[id] : undefined;
}
/** Metadata of the package with this definition id (e.g. `web.quick`). */
export function packageRuntimeOf(
	packageId: string,
): PackageRuntimeMeta | undefined {
	return Object.hasOwn(packages, packageId) ? packages[packageId] : undefined;
}
