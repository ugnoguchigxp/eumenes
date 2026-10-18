import type { ChatMessage } from "../../larm";
import { controlInstructions, type ControlContract } from "./index";

/**
 * The pieces both agent types share (spec subagent-task-and-session-agents 2026-10-18 §6): the fixed system
 * layer, the enclosed tool result, the repair notice, the check of which fields an action needs, and the
 * retries a tool gets after a refusal. A session turn (dialogue) and a single-shot task (`agent-task.ts`) differ
 * in their actions and loops, not in these.
 */

/** A tool as the agent sees it in TOOLS. */
export type AgentTool = {
	id: string;
	description: string;
	inputSchema: unknown;
};

/**
 * The agent's fixed instructions (D7, the system role): profile, SKILL, the common rules, TOOLS; the output
 * contract is rendered after them. Nothing of the conversation, memory or the current request joins them.
 */
export function agentControl(input: {
	profile: string;
	skills: readonly string[];
	rules: string;
	tools: readonly AgentTool[];
	outputSchema: unknown;
}): ControlContract {
	return {
		instructions:
			input.profile +
			"\n\n" +
			input.skills.join("\n\n") +
			"\n\n" +
			input.rules +
			"\nTOOLS=" +
			JSON.stringify(input.tools),
		outputSchema: input.outputSchema,
	};
}
export const agentSystemMessage = (control: ControlContract): ChatMessage => ({
	role: "system",
	content: controlInstructions(control),
});

const TOOL_RESULT_MAX_CHARS = 96_000;
/** The tool's result (or the host's refusal code) as the next input of the same run, enclosed as data. */
export function toolResultMessage(result: unknown): ChatMessage {
	const json = JSON.stringify(result);
	return {
		role: "user",
		content:
			"TOOL_RESULT=" +
			(json.length > TOOL_RESULT_MAX_CHARS
				? JSON.stringify({
						truncated: true,
						preview: json.slice(0, TOOL_RESULT_MAX_CHARS),
					})
				: json),
	};
}

const REJECTED_PREVIEW_CHARS = 2000;
/**
 * The rejected output kept short, with where it broke the contract, as data; `instruction` (the caller's
 * authored text) says to answer again. Never carries an input value beyond the short preview.
 */
export function rejectedOutputMessage(
	instruction: string,
	raw: string,
	violations: readonly unknown[],
	/** Model calls the run has left after the rejected one. */
	callsLeft: number,
): ChatMessage {
	return {
		role: "user",
		content:
			instruction +
			"\nREJECTED_OUTPUT=" +
			JSON.stringify({
				preview: raw.slice(0, REJECTED_PREVIEW_CHARS),
				issues: violations,
				callsLeft,
			}),
	};
}

/** Per action: the fields it needs and the fields it must not carry. */
export type ActionFields<Field extends string> = {
	needs: readonly Field[];
	refuses: readonly Field[];
};
/** The fields the chosen action lacks or must not carry; null when it is complete. */
export function actionFieldViolation<Field extends string>(
	action: string,
	fields: ActionFields<Field>,
	given: (field: Field) => boolean,
): { action: string; missing: Field[]; unexpected: Field[] } | null {
	const missing = fields.needs.filter((field) => !given(field));
	const unexpected = fields.refuses.filter(given);
	return missing.length || unexpected.length
		? { action, missing, unexpected }
		: null;
}

/** Retries after a refusal of `tool` within one run: its own setting, else `default`, else one. */
export const retriesFor = (
	retries: Readonly<Record<string, number>>,
	tool: string,
) => retries[tool] ?? retries.default ?? 1;
