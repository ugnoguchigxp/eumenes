import type { Database } from "bun:sqlite";
import type { Prepared } from "../../capabilities";
import type { ChildExecution, ToolRuntime } from "../../tool-runtime";
import { guidedWeb } from "./guided-contract";
import { RESOURCE_READ_TOOL, SCRATCH_WRITE_TOOL } from "./resource-access";
import type { RuntimeContext } from "./runtime-context";

/**
 * The host tools a worker is given besides its package's own (spec/server-scratch-cache-design-2026-11-07.md §4・
 * §9): `resource.read` when the host can read resources, and `scratch.write` when it can write shared files and the
 * worker works for a conversation (the file belongs to that conversation). A guided web worker keeps its fixed
 * steps; a package that already lists one keeps its own binding.
 */
export function hostBindings(
	ctx: RuntimeContext,
	db: Database,
	prepared: Prepared,
	execution: ChildExecution | undefined,
): ReturnType<ToolRuntime["bind"]> {
	if (guidedWeb(prepared)) return [];
	const listed = new Set(prepared.package.toolRevisionIds ?? []);
	const own = new Set(
		prepared.dependencies
			.filter((d) => d.kind === "tool" && listed.has(d.revisionId))
			.map((d) => d.id),
	);
	const offered: Array<[string, boolean]> = [
		[RESOURCE_READ_TOOL, !!ctx.deps.resources],
		[SCRATCH_WRITE_TOOL, !!ctx.deps.sharedWrite && !!execution],
	];
	return offered.flatMap(([id, available]) => {
		if (!available || own.has(id)) return [];
		const tool = ctx.deps.capabilities.activeToolInTransaction(db, id);
		// The ref only matches the grant to this binding: the tool runtime never sees a host tool.
		return tool ? [{ executionRef: crypto.randomUUID(), tool }] : [];
	});
}
