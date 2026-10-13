import type { LarmCallOptions, LarmPort } from "../contracts";
import type { Fetcher, Provider } from "./profiles";
import { startLlmTiming } from "./llm-timing";
import { countChatBody, validatedChatBody } from "./chat-input";
import { forwardToolCalls } from "../../../infrastructure/chat-stream";

/** Complete one claim-bound count and inference exchange, with unchanged stream/tool handling. */
export async function answerRequest(
	p: Provider,
	messages: Parameters<LarmPort["answer"]>[0],
	signal: AbortSignal,
	onDelta: ((text: string) => void) | undefined,
	options: LarmCallOptions | undefined,
	deps: {
		profile: string;
		request: Fetcher;
		sameClaim: () => boolean;
		send: (init: RequestInit) => Promise<Response>;
	},
) {
	if (!p.contextWindow) throw new Error("larm_missing_context_window");
	const timing = startLlmTiming(
		deps.profile,
		messages,
		p.contextWindow,
		options,
		onDelta,
		!!p.chatInput || messages.some((m) => m.images?.length),
	);
	try {
		const { body, serialized, count } = validatedChatBody(
			p,
			timing.selected,
			!!onDelta,
			options,
		);
		if (p.chatInput)
			timing.setRequestBytes(Buffer.byteLength(serialized, "utf8"));
		await countChatBody(p, body, serialized, count, signal, deps.request);
		if (!deps.sameClaim()) throw new Error("chat_input_contract_unavailable");
		signal.throwIfAborted();
		const response = await deps.send({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: serialized,
		});
		const result = await timing.read(response, signal);
		forwardToolCalls(result, options?.tools, options?.onToolCalls);
		return result.text;
	} catch (error) {
		timing.failed(signal);
		throw error;
	}
}
