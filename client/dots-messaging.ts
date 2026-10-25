import {
	messagingViewSchema,
	messagingSettingSchema,
	messageConversationSchema,
	outgoingMessageSchema,
} from "../api/domains/dots/contracts";
import { json, type Transport } from "./transport";
export function dotsMessagingClient(t: Transport) {
	return {
		configureDotsMessaging: async (
			id: string,
			expectedRevision: number,
			enabled: boolean,
		) =>
			messagingSettingSchema.parse(
				await (
					await t.call(
						`/api/dots/connections/${encodeURIComponent(id)}/messaging`,
						{ ...json({ expectedRevision, enabled }), method: "PUT" },
					)
				).json(),
			),
		openDotsMessageConversation: async (input: {
			requestId: string;
			connectionRef: string;
			conversationId: string;
		}) =>
			messageConversationSchema.parse(
				await (
					await t.call("/api/dots/message-conversations", json(input))
				).json(),
			),
		sendDotsMessage: async (
			id: string,
			input: { requestId: string; text: string },
		) =>
			outgoingMessageSchema.parse(
				await (
					await t.call(
						`/api/dots/message-conversations/${encodeURIComponent(id)}/messages`,
						json(input),
					)
				).json(),
			),
		dotsMessageConversation: async (id: string, after = 0, limit = 50) =>
			messagingViewSchema.parse(
				await (
					await t.call(
						`/api/dots/message-conversations/${encodeURIComponent(id)}?after=${after}&limit=${limit}`,
					)
				).json(),
			),
		cancelDotsMessage: async (
			id: string,
			input: { requestId: string; expectedRevision: number },
		) =>
			outgoingMessageSchema.parse(
				await (
					await t.call(
						`/api/dots/messages/${encodeURIComponent(id)}/cancel`,
						json(input),
					)
				).json(),
			),
	};
}
