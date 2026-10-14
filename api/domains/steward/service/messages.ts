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
