import { z } from "zod";
import {
	connectionSchema,
	projectSchema,
	nativeSession,
	connectionInput,
	projectInput,
} from "../api/domains/dots/contracts";
import { dotsPackageInput } from "../api/domains/capabilities/contracts";
import { json, type Transport } from "./transport";
const packageDto = dotsPackageInput.omit({ expectedToken: true }).extend({
	revision: z.number().int(),
	revisionId: z.string(),
	stateToken: z.string(),
});
export function dotsClient(transport: Transport) {
	return {
		dotsConfiguration: async () =>
			z
				.object({
					connections: z.array(connectionSchema),
					projects: z.array(projectSchema),
					events: z.array(
						z.object({
							connectionRef: z.string(),
							subscribed: z.boolean(),
							expiresAt: z.number().nullable(),
						}),
					),
				})
				.parse(await (await transport.call("/api/dots/configuration")).json()),
		configureDotsConnection: async (input: z.input<typeof connectionInput>) =>
			z
				.object({
					connection: connectionSchema,
					localToken: z.string().nullable(),
				})
				.parse(
					await (
						await transport.call("/api/dots/connections", {
							...json(input),
							method: "PUT",
						})
					).json(),
				),
		configureDotsProject: async (input: z.input<typeof projectInput>) =>
			projectSchema.parse(
				await (
					await transport.call("/api/dots/projects", {
						...json(input),
						method: "PUT",
					})
				).json(),
			),
		dotsPackages: async () =>
			z
				.object({ items: z.array(packageDto) })
				.parse(
					await (
						await transport.call("/api/capabilities/dots-packages")
					).json(),
				),
		configureDotsPackage: async (input: z.input<typeof dotsPackageInput>) =>
			packageDto.parse(
				await (
					await transport.call("/api/capabilities/dots-packages", {
						...json(input),
						method: "PUT",
					})
				).json(),
			),
		dotsTaskSessions: async (id: string) =>
			z
				.object({
					sessions: z.array(nativeSession),
					sourceSequence: z.number().int(),
				})
				.parse(
					await (
						await transport.call(
							`/api/dots/tasks/${encodeURIComponent(id)}/snapshot`,
						)
					).json(),
				),
		bindDotsSchedule: async (id: string, scheduleRef: string) =>
			z
				.object({
					taskId: z.string(),
					scheduleRef: z.string(),
					commandId: z.string(),
					expiresAt: z.number().int(),
				})
				.parse(
					await (
						await transport.call(
							`/api/dots/tasks/${encodeURIComponent(id)}/schedules`,
							json({ scheduleRef }),
						)
					).json(),
				),
	};
}
