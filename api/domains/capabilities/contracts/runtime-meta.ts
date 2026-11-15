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
	 * history: read of the conversation history; world: read of the host's own World (claims
	 * with their evidence);
	 * local_action: host action (no network).
	 */
	operation:
		| "search"
		| "read"
		| "saved_read"
		| "history"
		| "world"
		| "local_action"
		| "child";
	/**
	 * The tool takes a URL that must be one the user gave or an earlier observation returned.
	 * Tools with a scope are page reads: they use the per-task read budget, other reads allow one call.
	 */
	urlScope?: "request_or_observed";
	/** A paged non-URL read. Its adapter enforces the issued reference. */
	pagedRead?: true;
	/** Only offered once an earlier result left a saved body to read. */
	requiresSavedBody?: boolean;
	/** Cursor-paged search: repeated stale cursors end the task instead of retrying. */
	cursorPaging?: boolean;
};
export type PackageRuntimeMeta = {
	budget?: "service";
	/** Return source-linked findings directly, without requirement extraction or grading. */
	report?: "search";
	/**
	 * set: the package's own profile and SKILL are the sub-agent's route policy (system).
	 * No generic route policy is added, and the bodies are not repeated as data.
	 */
	context?: "set";
	/** A package with its own tools only, such as a read-only archive worker. */
	hostTools?: "none";
	/** Optional override for packages using the source-linked search report. */
	searches?: number;
	/**
	 * The time this package's research worker is given (ms), instead of the research default. A run that hands work to
	 * it, and whose deadline is not fixed from outside, is given that time and the parent's margin.
	 */
	researchMs?: number;
};

const tools: Readonly<Record<string, ToolRuntimeMeta>> = {
	"browser.research": { operation: "child" },
	"web.lookup": { operation: "search" },
	"web.read": { operation: "read", urlScope: "request_or_observed" },
	"web.find": { operation: "saved_read", requiresSavedBody: true },
	"web.read_saved": { operation: "saved_read", requiresSavedBody: true },
	"history.search": { operation: "history", cursorPaging: true },
	"history.read": { operation: "history" },
	"archive.search": { operation: "search" },
	"archive.read": { operation: "read", pagedRead: true },
	"world.find": { operation: "world" },
	"world.documents": { operation: "world" },
	"world.query": { operation: "world" },
	"timer.start": { operation: "local_action" },
	"timer.cancel": { operation: "local_action" },
	"timer.list": { operation: "local_action" },
};
const packages: Readonly<Record<string, PackageRuntimeMeta>> = {
	"web.service-search": {
		budget: "service",
		report: "search",
		context: "set",
		researchMs: 330000,
	},
	"world.query": { report: "search", context: "set" },
	"resource.research": {
		report: "search",
		context: "set",
		hostTools: "none",
		searches: 2,
	},
	// Reaches back over old conversations (spec conversation-read-tools-design 2026-10-31 §8).
	"history.research": { researchMs: 300000 },
};
const toolchains: Readonly<
	Record<string, import("./toolchains").ToolchainRuntimeMeta>
> = {
	"web.service-search": {
		execution: "research",
		route: "web",
		autonomy: "read",
	},
	"history.research": {
		execution: "research",
		route: "history",
		autonomy: "read",
	},
	"world.query": {
		execution: "research",
		route: "world",
		requires: "world",
		autonomy: "read",
	},
	"excalidraw.edit": { execution: "excalidraw", requires: "excalidraw" },
	"object-recognition.manage": {
		execution: "command",
		requires: "object-recognition",
	},
	"image.create": { execution: "image", requires: "image", autonomy: "create" },
	"music.create": {
		execution: "music-create",
		requires: "music",
		autonomy: "create",
	},
	"music.library": { execution: "music-playback", requires: "music" },
};
/** Host metadata of a toolchain by definition id. */
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
/** Metadata of the package with this definition id. */
export function packageRuntimeOf(
	packageId: string,
): PackageRuntimeMeta | undefined {
	return Object.hasOwn(packages, packageId) ? packages[packageId] : undefined;
}
