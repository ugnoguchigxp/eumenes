import type { Database } from "bun:sqlite";
import { scratchWrite, type Prepared } from "../../capabilities";
import { parseResourceUri } from "../../resources";
import type { ChildExecution, ToolRuntime } from "../../tool-runtime";
import { safeCode } from "./control-output";
import { guidedWeb } from "./guided-contract";
import {
	RESOURCE_READ_TOOL,
	SCRATCH_WRITE_TOOL,
	type StoredRead,
	type StoredWrite,
} from "./resource-access";
import type { RuntimeContext } from "./runtime-context";
import type { StepInput } from "./step-actions";

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

/** The read a `resource.read` invocation asks for, made now because the host's port is async. */
export async function requestedRead(
	ctx: RuntimeContext,
	input: StepInput,
	action: unknown,
	signal: AbortSignal,
): Promise<StoredRead | undefined> {
	const invoke = action as {
		action?: string;
		tool?: string;
		arguments?: { uri?: unknown; offset?: unknown };
	} | null;
	if (
		!ctx.deps.resources ||
		invoke?.action !== "invoke" ||
		invoke.tool !== RESOURCE_READ_TOOL ||
		!input.grants.some((g) => g.id === RESOURCE_READ_TOOL && !g.replayOnly)
	)
		return undefined;
	const parsed =
		typeof invoke.arguments?.uri === "string"
			? parseResourceUri(invoke.arguments.uri)
			: null;
	// An unlisted URI is never read; the action is then rejected as `unknown_resource` when it is applied.
	if (!parsed || !input.resourceUris.has(parsed.uri)) return undefined;
	const offset =
		typeof invoke.arguments?.offset === "number" &&
		Number.isInteger(invoke.arguments.offset) &&
		invoke.arguments.offset > 0
			? invoke.arguments.offset
			: undefined;
	const at = offset === undefined ? {} : { offset };
	try {
		return {
			uri: parsed.uri,
			...at,
			...(await ctx.deps.resources.read(
				parsed.uri,
				signal,
				offset === undefined ? undefined : at,
			)),
		};
	} catch (error) {
		return { uri: parsed.uri, ...at, ok: false, code: safeCode(error) };
	}
}
/**
 * The file a `scratch.write` invocation asks for, written now because the host's port is async. Its arguments
 * are checked again when the action is applied; one the schema refuses is never written.
 */
export async function requestedWrite(
	ctx: RuntimeContext,
	input: StepInput,
	action: unknown,
	signal: AbortSignal,
): Promise<StoredWrite | undefined> {
	const invoke = action as {
		action?: string;
		tool?: string;
		arguments?: unknown;
	} | null;
	const conversationId = input.execution?.source.conversationId;
	if (
		!ctx.deps.sharedWrite ||
		!conversationId ||
		invoke?.action !== "invoke" ||
		invoke.tool !== SCRATCH_WRITE_TOOL ||
		!input.grants.some((g) => g.id === SCRATCH_WRITE_TOOL && !g.replayOnly)
	)
		return undefined;
	const args = scratchWrite.safeParse(invoke.arguments);
	if (!args.success) return undefined;
	const maker = ctx.state.prepared.get(input.taskId)?.package.title ?? "担当";
	try {
		return {
			name: args.data.name,
			...(await ctx.deps.sharedWrite.write(
				args.data,
				{ conversationId, maker },
				signal,
			)),
		};
	} catch (error) {
		return { name: args.data.name, ok: false, code: safeCode(error) };
	}
}
