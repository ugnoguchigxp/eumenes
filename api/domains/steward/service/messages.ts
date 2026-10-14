import type { ChatMessage } from "../contracts";
import type { StepDefinition } from "./types";

/** The system message carries the instructions and the schema the answer must follow, the way control requests do. */
function systemMessage(step: StepDefinition): string {
	return `${step.instructions}\nOUTPUT_SCHEMA=${JSON.stringify(step.outputSchema)}`;
}
export function buildMessages(
	step: StepDefinition,
	data: unknown,
): ChatMessage[] {
	return [
		{ role: "system", content: systemMessage(step) },
		{ role: "user", content: JSON.stringify(data) },
	];
}
