import { supervisorViewSchema } from "../api/domains/coding-supervision/contracts";
import { reportListSchema } from "../api/domains/task-reports/contracts";
import { callJson, withQuery, type Transport } from "./transport";
export function codingSupervisionClient(transport: Transport) {
	const path = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
	return {
		taskSupervisor: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				supervisorViewSchema.nullable(),
				`${path(id)}/supervisor`,
				{
					signal,
				},
			),
		taskReports: async (
			id: string,
			after = 0,
			limit = 50,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				reportListSchema,
				withQuery(`${path(id)}/reports`, { after, limit }),
				{ signal },
			),
	};
}
