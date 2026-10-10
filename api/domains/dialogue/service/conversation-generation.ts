import type { InferencePort, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { operation, type ConversationOperation } from "./conversation-tools";

type Messages = Parameters<InferencePort["answer"]>[0];

/** One ordinary call; at most one structural correction of a native operation. */
export async function generateConversation(input: {
	inference: InferencePort;
	requestId?: string;
	messages: Messages;
	signal: AbortSignal;
	delta: (text: string) => void;
	preparation?: SpeechPreparation;
	tools?: NativeTool[];
	repair: () => void;
}): Promise<{
	text: string;
	receipt?: Receipt;
	operation?: ConversationOperation;
}> {
	const { inference, signal } = input;
	let messages = input.messages;
	for (let attempt = 0; attempt < 2; attempt++) {
		signal.throwIfAborted();
		const receipt =
			input.requestId && inference.executeRequest
				? inference.executeStream
					? await inference.executeStream(
							input.requestId,
							messages,
							signal,
							input.delta,
							input.preparation,
							input.tools,
						)
					: await inference.executeRequest(
							input.requestId,
							messages,
							signal,
							input.preparation,
						)
				: undefined;
		const text = receipt
			? (receipt.value as string)
			: inference.answerStream
				? await inference.answerStream(messages, signal, input.delta)
				: await inference.answer(messages, signal);
		if (!receipt?.toolCalls?.length) return { text, receipt };
		try {
			if (!input.tools || text.trim())
				throw new Error("invalid_conversation_operation");
			return {
				text: "",
				receipt,
				operation: operation(receipt.toolCalls, input.tools),
			};
		} catch {
			if (attempt === 1) throw new Error("invalid_conversation_operation");
			input.repair();
			messages = [
				...input.messages,
				{
					role: "system",
					content:
						"前回の操作出力は契約に合いませんでした。提示済みのfunctionの引数形式で一つだけ操作を返すか、自然文で回答します。操作と本文を混ぜません。一度だけ修正します。",
				},
			];
		}
	}
	throw new Error("invalid_conversation_operation");
}
