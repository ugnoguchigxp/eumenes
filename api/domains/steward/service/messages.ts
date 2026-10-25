import type { ChatMessage } from "../contracts";
import type { PreparedUnit, StepDefinition } from "./types";

/** The system message carries the instructions and the schema the answer must follow, the way control requests do. */
function systemMessage(step: StepDefinition, prepared: PreparedUnit): string {
	return `${step.instructions}\nOUTPUT_SCHEMA=${JSON.stringify(step.outputSchema(prepared))}`;
}
export function buildMessages(
	step: StepDefinition,
	prepared: PreparedUnit,
	data: unknown,
): ChatMessage[] {
	return [
		{ role: "system", content: systemMessage(step, prepared) },
		{ role: "user", content: JSON.stringify(data) },
	];
}

/**
 * A step's own last message after the conversation's prefix (the ContextWindow layout specification, section 5.2):
 * the task's instructions, the schema its answer follows, and its input.
 */
export function taskMessage(
	step: StepDefinition,
	prepared: PreparedUnit,
	data: unknown,
): ChatMessage {
	return {
		role: "user",
		content: `<task name="${step.id}">\n${systemMessage(step, prepared)}\n入力:\n${JSON.stringify(data)}\n</task>`,
	};
}
