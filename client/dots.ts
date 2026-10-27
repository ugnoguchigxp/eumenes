import { dotsMessagingClient } from "./dots-messaging";
import {
	messagingSettingSchema,
	messageConversationSchema,
} from "../api/domains/dots/contracts";
import { z } from "zod";
import {
	connectionSchema,
	projectSchema,
	nativeSession,
	connectionInput,
	projectInput,
} from "../api/domains/dots/contracts";
import { dotsPackageInput } from "../api/domains/capabilities/contracts";
import { callJson, json, type Transport } from "./transport";
const packageDto = dotsPackageInput.omit({ expectedToken: true }).extend({
	revision: z.number().int(),
	revisionId: z.string(),
	stateToken: z.string(),
});
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
		configureDotsConnection: async (input: z.input<typeof connectionInput>) =>
			callJson(
				transport,
				z.object({
					connection: connectionSchema,
					localToken: z.string().nullable(),
				}),
				"/api/dots/connections",
				json(input, "PUT"),
			),
		configureDotsProject: async (input: z.input<typeof projectInput>) =>
			callJson(
				transport,
				projectSchema,
				"/api/dots/projects",
				json(input, "PUT"),
			),
		dotsPackages: async () =>
			callJson(
				transport,
				z.object({ items: z.array(packageDto) }),
				"/api/capabilities/dots-packages",
			),
		configureDotsPackage: async (input: z.input<typeof dotsPackageInput>) =>
			callJson(
				transport,
				packageDto,
				"/api/capabilities/dots-packages",
				json(input, "PUT"),
			),
		dotsTaskSessions: async (id: string) =>
			callJson(
				transport,
				z.object({
					sessions: z.array(nativeSession),
					sourceSequence: z.number().int(),
				}),
				`/api/dots/tasks/${encodeURIComponent(id)}/snapshot`,
			),
		bindDotsSchedule: async (id: string, scheduleRef: string) =>
			callJson(
				transport,
				z.object({
					taskId: z.string(),
					scheduleRef: z.string(),
					commandId: z.string(),
					expiresAt: z.number().int(),
				}),
				`/api/dots/tasks/${encodeURIComponent(id)}/schedules`,
				json({ scheduleRef }),
			),
	};
}
