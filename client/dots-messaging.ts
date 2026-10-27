import {
	messagingViewSchema,
	messagingSettingSchema,
	messageConversationSchema,
	outgoingMessageSchema,
} from "../api/domains/dots/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";
export function dotsMessagingClient(t: Transport) {
	return {
		configureDotsMessaging: async (
			id: string,
			expectedRevision: number,
			enabled: boolean,
		) =>
			callJson(
				t,
				messagingSettingSchema,
				`/api/dots/connections/${encodeURIComponent(id)}/messaging`,
				json({ expectedRevision, enabled }, "PUT"),
			),
		openDotsMessageConversation: async (input: {
			requestId: string;
			connectionRef: string;
			conversationId: string;
		}) =>
			callJson(
				t,
				messageConversationSchema,
				"/api/dots/message-conversations",
				json(input),
			),
		sendDotsMessage: async (
			id: string,
			input: { requestId: string; text: string },
		) =>
			callJson(
				t,
				outgoingMessageSchema,
				`/api/dots/message-conversations/${encodeURIComponent(id)}/messages`,
				json(input),
			),
		dotsMessageConversation: async (id: string, after = 0, limit = 50) =>
			callJson(
				t,
				messagingViewSchema,
				withQuery(`/api/dots/message-conversations/${encodeURIComponent(id)}`, {
					after,
					limit,
				}),
			),
		cancelDotsMessage: async (
			id: string,
			input: { requestId: string; expectedRevision: number },
		) =>
			callJson(
				t,
				outgoingMessageSchema,
				`/api/dots/messages/${encodeURIComponent(id)}/cancel`,
				json(input),
			),
	};
}
