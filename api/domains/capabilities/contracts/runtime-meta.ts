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
	 * history: read of the conversation history; recipe: saved fetch procedures of the
	 * toolchain (host-local); local_action: host action (no network).
	 */
	operation:
		| "search"
		| "read"
		| "saved_read"
		| "history"
		| "recipe"
		| "local_action";
	/**
	 * The tool takes a URL that must be one the user gave or an earlier observation returned.
	 * Tools with a scope are page reads: they use the per-task read budget, other reads allow one call.
	 */
	urlScope?: "request_or_observed";
	/** Only offered once an earlier result left a saved body to read. */
	requiresSavedBody?: boolean;
	/** Cursor-paged search: repeated stale cursors end the task instead of retrying. */
	cursorPaging?: boolean;
};
export type PackageRuntimeMeta = {
	/**
	 * quick: the small web budget (one search, one read, fewer model calls).
	 * recipe: quick plus one saved-procedure lookup and one extra read for a failed fixed URL.
	 */
	budget?: "quick" | "recipe";
	/** Return source-linked findings directly, without requirement extraction or grading. */
	report?: "search";
	/**
	 * set: the package's own profile and SKILL are the sub-agent's route policy (system).
	 * No generic route policy is added, and the bodies are not repeated as data.
	 */
	context?: "set";
};

const tools: Readonly<Record<string, ToolRuntimeMeta>> = {
	"web.lookup": { operation: "search" },
	"web.read": { operation: "read", urlScope: "request_or_observed" },
	"web.forecast": { operation: "read" },
	"web.quote": { operation: "read" },
	"recipe.find": { operation: "recipe" },
	"web.find": { operation: "saved_read", requiresSavedBody: true },
	"web.read_saved": { operation: "saved_read", requiresSavedBody: true },
	"history.search": { operation: "history", cursorPaging: true },
	"history.read": { operation: "history" },
	"timer.start": { operation: "local_action" },
	"timer.cancel": { operation: "local_action" },
	"timer.list": { operation: "local_action" },
};
const packages: Readonly<Record<string, PackageRuntimeMeta>> = {
	"web.quick": { budget: "quick", report: "search" },
	"web.search": { report: "search" },
	"web.recipe": { budget: "recipe", report: "search", context: "set" },
};
const toolchains: Readonly<
	Record<string, import("./toolchains").ToolchainRuntimeMeta>
> = {
	"web.search": { execution: "research", route: "web" },
	"web.research.luna": {
		execution: "research",
		route: "web",
		requires: "luna",
		researcher: "codex_luna",
	},
	"history.research": { execution: "research", route: "history" },
	"excalidraw.edit": { execution: "excalidraw", requires: "excalidraw" },
	"object-recognition.manage": {
		execution: "command",
		requires: "object-recognition",
	},
	"image.create": { execution: "image", requires: "image" },
	"music.create": { execution: "music-create", requires: "music" },
	"music.library": { execution: "music-playback", requires: "music" },
	"dots.delegate": { execution: "command", requires: "dots" },
};
/** Host metadata of a toolchain by definition id (e.g. `web.search`). */
export function toolchainRuntimeOf(
	toolchainId: string,
): import("./toolchains").ToolchainRuntimeMeta | undefined {
	return Object.hasOwn(toolchains, toolchainId)
		? toolchains[toolchainId]
		: undefined;
}
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
