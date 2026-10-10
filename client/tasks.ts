import {
	type CreateTask,
	type TaskGrantInput,
	type TaskReceipt,
	taskReceiptSchema,
	taskDetailSchema,
	taskListSchema,
	taskEventListSchema,
} from "../api/domains/tasks/contracts";
import { json, type Transport } from "./transport";

export function tasksClient(transport: Transport) {
	const path = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
	const post = async (target: string, body: unknown): Promise<TaskReceipt> =>
		taskReceiptSchema.parse(
			await (await transport.call(target, json(body))).json(),
		);
	return {
		forgetTask: (id: string, requestId: string, expectedRevision: number) =>
			post(`${path(id)}/forget`, { requestId, expectedRevision }),
		createTask: (input: CreateTask) => post("/api/tasks", input),
		workTask: async (id: string, signal?: AbortSignal) =>
			taskDetailSchema.parse(
				await (await transport.call(path(id), { signal })).json(),
			),
		workTasks: async (
			query: {
				state?: string;
				conversationId?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query))
				if (v !== undefined) params.set(k, String(v));
			return taskListSchema.parse(
				await (await transport.call(`/api/tasks?${params}`, { signal })).json(),
			);
		},
		workTaskEvents: async (
			id: string,
			cursor = "0",
			limit = 50,
			signal?: AbortSignal,
		) =>
			taskEventListSchema.parse(
				await (
					await transport.call(
						`${path(id)}/events?${new URLSearchParams({ cursor, limit: String(limit) })}`,
						{ signal },
					)
				).json(),
			),
		startTask: (id: string, requestId: string, expectedRevision: number) =>
			post(`${path(id)}/start`, { requestId, expectedRevision }),
		stopTask: (
			id: string,
			requestId: string,
			expectedRevision: number,
			intent: "pause" | "cancel",
		) => post(`${path(id)}/stop`, { requestId, expectedRevision, intent }),
		amendTask: (
			id: string,
			input: {
				requestId: string;
				expectedRevision: number;
				grant:
					| TaskGrantInput
					| import("../api/domains/tasks/contracts").OrchestrationGrant;
			},
		) => post(`${path(id)}/amend`, input),
		answerTask: (
			id: string,
			input: {
				requestId: string;
				expectedRevision: number;
				questionId: string;
				answer: string;
			},
		) => post(`${path(id)}/answers`, input),
	};
}
