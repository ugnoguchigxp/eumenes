import { z } from "zod";
import {
	codingWorkspaceViewSchema,
	codingExecutionEventsSchema,
	executionViewSchema,
} from "../api/domains/coding/contracts";
import type { Transport } from "./transport";
export function codingClient(transport: Transport) {
	const path = (id: string) =>
		`/api/coding/executions/${encodeURIComponent(id)}`;
	return {
		codingWorkspaces: async (signal?: AbortSignal) =>
			z
				.strictObject({ items: z.array(codingWorkspaceViewSchema) })
				.parse(
					await (
						await transport.call("/api/coding/workspaces", { signal })
					).json(),
				),
		codingExecution: async (id: string, signal?: AbortSignal) =>
			executionViewSchema.parse(
				await (await transport.call(path(id), { signal })).json(),
			),
		codingExecutionEvents: async (
			id: string,
			after = 0,
			limit = 100,
			signal?: AbortSignal,
		) =>
			codingExecutionEventsSchema.parse(
				await (
					await transport.call(
						`${path(id)}/events?${new URLSearchParams({ after: String(after), limit: String(limit) })}`,
						{ signal },
					)
				).json(),
			),
	};
}
