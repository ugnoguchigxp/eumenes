import type { LarmPort, LarmCallOptions } from "../contracts";
import { nativeToolOptions } from "../../../infrastructure/chat-stream";
export function chatRequest(
	provider: { model: string; contextWindow?: { outputReserveTokens: number } },
	messages: Parameters<LarmPort["answer"]>[0],
	stream: boolean,
	options?: LarmCallOptions,
) {
	return {
		model: provider.model,
		messages,
		...(options?.jsonOutput
			? { temperature: 0, response_format: { type: "json_object" } }
			: {}),
		...nativeToolOptions(options?.tools),
		stream,
		max_tokens: Math.min(
			provider.contextWindow!.outputReserveTokens,
			options?.maxOutputTokens ?? 4096,
		),
	};
}
