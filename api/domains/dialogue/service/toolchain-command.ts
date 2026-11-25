import { systemContext } from "../../../infrastructure/system-context";
import { z } from "zod";
import { getLogger } from "../../../infrastructure/logger";
import {
	controlInstructions,
	delegatedTaskRules,
	promptTime,
	type ControlContract,
} from "../../inference";
import { recognitionCommand } from "../../capabilities";

const log = getLogger("dialogue");

/** The generic question schema; every binding allows it. */
export const ANSWER_TEXT_SCHEMA = "builtin:answerText";

/**
 * The sub-agent's whole contract: one tool of the set with flat arguments, or one question
 * back to the user. No discriminated union: the model fills one object.
 */
export function commandOutputFor(questionRefs: readonly string[]) {
	return z
		.object({
			action: z.enum(["invoke", "clarify"]),
			tool: z.string().min(1).max(64).optional(),
			arguments: z.record(z.string(), z.unknown()).optional(),
			question: z.string().trim().min(1).max(500).optional(),
			/** The registered schema the user's answer to `question` is checked against. */
			answerSchema: z
				.enum([ANSWER_TEXT_SCHEMA, ...questionRefs] as [string, ...string[]])
				.optional(),
		})
		.strict()
		.meta({
			examples: [
				{ action: "invoke", tool: "TOOLSのid", arguments: {} },
				{
					action: "clarify",
					question: "ユーザーへの確認質問",
					answerSchema: ANSWER_TEXT_SCHEMA,
				},
			],
		});
}
const COMMAND_RULES = systemContext(
	"dialogue.contexts.toolchain-command.command-rules",
	{},
);

/** The fixed set as the sub-agent's SystemContext, and the request as data. */
export function commandPrompt(
	set: { profile: string; skills: string[] },
	tools: Array<{ id: string; description: string; inputSchema: unknown }>,
	data: Record<string, unknown>,
	questionRefs: readonly string[],
	nowMs: number,
) {
	const control: ControlContract = {
		instructions:
			delegatedTaskRules +
			"\n" +
			set.profile +
			"\n\n" +
			set.skills.join("\n\n") +
			"\n\n" +
			COMMAND_RULES +
			"\nTOOLS=" +
			JSON.stringify(tools),
		outputSchema: z.toJSONSchema(commandOutputFor(questionRefs)),
	};
	return {
		control,
		messages: [
			{ role: "system" as const, content: controlInstructions(control) },
			{
				role: "user" as const,
				content: JSON.stringify({
					...data,
					...promptTime(nowMs),
				}),
			},
		],
	};
}

export function parseToolCommand(
	input: { backend: string | undefined; toolIds: Record<string, string> },
	out: z.infer<ReturnType<typeof commandOutputFor>>,
) {
	const operation = out.tool ? input.toolIds[out.tool] : undefined;
	if (!operation) throw new Error("toolchain_command_tool_unknown");
	const raw = { ...out.arguments, operation };
	if (input.backend !== "object-recognition")
		throw new Error("adapter_unavailable");
	const command = recognitionCommand.safeParse(raw);
	if (!command.success) {
		log.warn("dialogue.operation_rejected", {
			reason: "command_arguments_invalid",
			controlAction: input.toolIds[out.tool!] ? out.tool : "unknown",
			issueCount: command.error.issues.length,
		});
		throw new Error("toolchain_command_invalid_arguments");
	}
	return command.data;
}
