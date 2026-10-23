import { systemContext } from "../../api/infrastructure/system-context";
import type { Messages } from "../../api/domains/inference/contracts";

/** Evaluation-only placement in the leading instruction; later system messages may be ignored by a template. */
export function stableDecisionLayout(original: Messages): Messages {
	const content = systemContext(
		"dialogue.contexts.request-analysis.instruction",
		{},
	);
	const at = original.findIndex(
		(m) => m.role === "system" && m.content === content,
	);
	if (at < 0) throw new Error("decision_instruction_missing");
	const messages = [...original];
	const [instruction] = messages.splice(at, 1);
	if (messages[0]?.role === "system")
		messages[0] = {
			...messages[0],
			content: messages[0].content + "\n" + instruction!.content,
		};
	else messages.unshift(instruction!);
	return messages;
}
