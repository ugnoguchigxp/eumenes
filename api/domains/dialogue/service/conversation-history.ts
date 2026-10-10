import type { Tx } from "../../queue";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import { priorRuns } from "../repository";
import { buildSystemPrompt } from "./system-prompt";
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** Model-visible history: earlier accepted runs (input + adopted answer) then this run's input. */
export function historyFor(
	tx: Tx,
	run: Run,
	referenceBlocks: readonly string[],
	conversation: ConversationService,
	general?: Parameters<typeof buildSystemPrompt>[0],
): ChatMessage[] {
	const messages = new Map(
		conversation
			.messagesInTransaction(tx, run.conversationId)
			.map((m) => [m.id, m]),
	);
	const out: ChatMessage[] = [
		{
			role: "system",
			content: buildSystemPrompt(
				general ?? { agentName: "", userName: "", persona: "butler" },
			),
		},
	];
	// Memory and World are reference data, never an instruction: each gets its own labelled message.
	for (const block of referenceBlocks)
		if (block) out.push({ role: "system", content: block });
	const push = (messageId: string | null, role: "user" | "assistant") => {
		const m = messageId ? messages.get(messageId) : undefined;
		if (m) out.push({ role, content: m.text });
	};
	for (const prior of priorRuns(tx, run)) {
		push(prior.inputMessageId, "user");
		if (prior.status === "completed") push(prior.answerMessageId, "assistant");
	}
	push(run.inputMessageId, "user");
	return out;
}
