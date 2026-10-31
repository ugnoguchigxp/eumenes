import { dotsMessagingClient } from "./dots-messaging";
import {
	messagingSettingSchema,
	messageConversationSchema,
} from "../api/domains/dots/contracts";
import { z } from "zod";
import { connectionSchema, projectSchema } from "../api/domains/dots/contracts";
import { callJson, type Transport } from "./transport";
export function dotsClient(transport: Transport) {
	return {
		...dotsMessagingClient(transport),
		dotsConfiguration: async () =>
			callJson(
				transport,
				z.object({
					connections: z.array(connectionSchema),
					messageConversations: z.array(messageConversationSchema).optional(),
					projects: z.array(projectSchema),
					events: z.array(
						z.object({
							connectionRef: z.string(),
							messaging: messagingSettingSchema.optional(),
							subscribed: z.boolean(),
							expiresAt: z.number().nullable(),
						}),
					),
				}),
				"/api/dots/configuration",
			),
	};
}
