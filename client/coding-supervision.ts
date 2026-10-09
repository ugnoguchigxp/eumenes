import { supervisorViewSchema } from "../api/domains/coding-supervision/contracts";
import { reportListSchema } from "../api/domains/task-reports/contracts";
import type { Transport } from "./transport";
export function codingSupervisionClient(transport: Transport) {
	const path = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
	return {
		taskSupervisor: async (id: string, signal?: AbortSignal) =>
			supervisorViewSchema
				.nullable()
				.parse(
					await (
						await transport.call(`${path(id)}/supervisor`, { signal })
					).json(),
				),
		taskReports: async (
			id: string,
			after = 0,
			limit = 50,
			signal?: AbortSignal,
		) =>
			reportListSchema.parse(
				await (
					await transport.call(
						`${path(id)}/reports?${new URLSearchParams({ after: String(after), limit: String(limit) })}`,
						{ signal },
					)
				).json(),
			),
	};
}
