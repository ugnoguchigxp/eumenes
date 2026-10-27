import { z } from "zod";
import {
	codingWorkspaceViewSchema,
	codingExecutionEventsSchema,
	executionViewSchema,
} from "../api/domains/coding/contracts";
import { callJson, withQuery, type Transport } from "./transport";
export function codingClient(transport: Transport) {
	const path = (id: string) =>
		`/api/coding/executions/${encodeURIComponent(id)}`;
	return {
		codingWorkspaces: async (signal?: AbortSignal) =>
			callJson(
				transport,
				z.strictObject({ items: z.array(codingWorkspaceViewSchema) }),
				"/api/coding/workspaces",
				{ signal },
			),
		codingExecution: async (id: string, signal?: AbortSignal) =>
			callJson(transport, executionViewSchema, path(id), { signal }),
		codingExecutionEvents: async (
			id: string,
			after = 0,
			limit = 100,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				codingExecutionEventsSchema,
				withQuery(`${path(id)}/events`, { after, limit }),
				{ signal },
			),
	};
}
