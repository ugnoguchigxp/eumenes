import { z } from "zod";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import { readToolInputs, type ReadToolName } from "../../capabilities";
import {
	ValidationFailure,
	repairIssues,
	validationIssues,
	type RepairIssue,
} from "../../../infrastructure/validation-log";

/**
 * The fixed tools of the conversation agent: the same set in every generation, so a template that puts tool
 * definitions before the prompt never breaks the cached prefix. No toolchain is named here; candidates come back as
 * the result of the search tool. A description says what the tool does and what its arguments mean; when to use it
 * is the system part's (the conversation input specification, section 4.3).
 */
export const TOOL_NAMES = {
	memory: "memory",
	search: "find_toolchain",
	delegate: "delegate",
	work: "work",
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/*
 * Two forms of each tool's arguments. The host validates every call against the zod schemas below, with every
 * bound and every mode's required fields. The model reads the compact definitions further down: one flat object
 * per tool, ids without length bounds, and only the limits that change what it writes stated in the description.
 */
const id = z.string().trim().min(1).max(160);
const impacts = ["none", "create", "modify_existing", "irreversible"] as const;

export const memoryArgs = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("request"),
			kind: z.enum(["forget", "remember", "correct", "goal", "withdraw"]),
			what: z.string().trim().min(1).max(500),
			detail: z.string().trim().max(1000).optional(),
		})
		.strict(),
]);
export type MemoryArgs = z.infer<typeof memoryArgs>;

export const searchArgs = z
	.object({ query: z.string().trim().min(1).max(2000) })
	.strict();

const announcement = z.string().trim().min(1).max(80);

export const delegateArgs = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.enum(["execute", "confirm"]),
			toolchain: id,
			/** Asked for by the definition; an instant toolchain answers from its inputs alone, any other refuses it absent. */
			request: z.string().trim().min(1).max(8000).optional(),
			announcement: announcement.optional(),
			/** Asked for by the definition; absent, the host takes it from the target and the toolchain (D7). */
			impact: z.enum(impacts).optional(),
			inputs: z.record(z.string(), z.unknown()).optional(),
			target: id.optional(),
			/** The resources handed over with the request (`a<n>` of the ledger). */
			refs: z
				.array(z.string().regex(/^a\d+$/))
				.max(8)
				.optional(),
			resolveUnsaved: z.literal("discard").optional(),
		})
		.strict(),
	z
		.object({
			mode: z.literal("approve"),
			confirmation: id,
			announcement: announcement.optional(),
			/** Not needed to approve; a call that carries it is not refused. */
			impact: z.enum(impacts).optional(),
		})
		.strict(),
]);
export type DelegateArgs = z.infer<typeof delegateArgs>;

export const workArgs = z
	.object({
		todo: id,
		operation: z.enum(["check", "answer", "amend", "cancel"]),
		text: z.string().trim().min(1).max(8000).optional(),
	})
	.strict();
export type WorkArgs = z.infer<typeof workArgs>;

export type ParsedCall =
	| { name: "memory"; call: NativeToolCall; args: MemoryArgs }
	| {
			name: "find_toolchain";
			call: NativeToolCall;
			args: z.infer<typeof searchArgs>;
	  }
	| { name: "delegate"; call: NativeToolCall; args: DelegateArgs }
	| { name: "work"; call: NativeToolCall; args: WorkArgs }
	| { name: ReadToolName; call: NativeToolCall; args: Record<string, unknown> };

/** The fixed tools and the read tools (the talk turn's, spec conversation-read-tools-design 2026-10-31). */
const schemas: Record<ToolName | ReadToolName, z.ZodType> = {
	memory: memoryArgs,
	find_toolchain: searchArgs,
	delegate: delegateArgs,
	work: workArgs,
	...readToolInputs,
};

/**
 * A call the host refuses; the agent reads the reason as the call's result (no arguments or text reach the log), and
 * the fields to repair when they are given.
 */
export function toolRejection(
	code: string,
	issues: Record<string, unknown>[] = [],
	repair?: RepairIssue[],
) {
	return new ValidationFailure(
		code,
		issues.length ? issues : [{ reason: code }],
		undefined,
		repair,
	);
}

/** A hand-over without its request text: every toolchain but an instant one works from it. */
export const requestRequired = () =>
	toolRejection(
		"invalid_tool_arguments",
		[{ tool: TOOL_NAMES.delegate, path: "request", reason: "required" }],
		[{ path: "request", code: "required", expected: "string" }],
	);

/** Checks one call against its tool's schema; an unknown tool or invalid arguments is a structural violation. */
export function parseCall(call: NativeToolCall): ParsedCall {
	const schema = Object.hasOwn(schemas, call.name)
		? schemas[call.name as ToolName | ReadToolName]
		: undefined;
	if (!schema)
		throw toolRejection("unknown_tool", [{ reason: "unknown_tool" }]);
	let value: unknown;
	try {
		value = JSON.parse(call.arguments || "{}");
	} catch {
		throw toolRejection("tool_arguments_not_json", [
			{ tool: call.name, reason: "tool_arguments_not_json" },
		]);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new ValidationFailure(
			"invalid_tool_arguments",
			validationIssues(parsed.error, value, [call.name]),
			undefined,
			repairIssues(parsed.error, value),
		);
	return { name: call.name, call, args: parsed.data } as ParsedCall;
}
