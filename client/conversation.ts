import { conversationSchema } from "../api/domains/conversation/contracts";
import type { Transport } from "./transport";
export function conversationClient(transport: Transport) {
	return {
		identity: transport.identity,
		conversation: async (id: string, signal?: AbortSignal) =>
			conversationSchema.parse(
				await (
					await transport.call(`/api/conversations/${encodeURIComponent(id)}`, {
						signal,
					})
				).json(),
			),
	};
}
export type ConversationClient = ReturnType<typeof conversationClient>;
