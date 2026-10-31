import {
	type CreateTask,
	type TaskReceipt,
	taskReceiptSchema,
	taskDetailSchema,
	taskListSchema,
	taskEventListSchema,
} from "../api/domains/tasks/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

import type { OrchestrationGrant } from "../api/domains/tasks/contracts";
export function tasksClient(transport: Transport) {
	const path = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
	const post = (target: string, body: unknown): Promise<TaskReceipt> =>
		callJson(transport, taskReceiptSchema, target, json(body));
	return {
		forgetTask: (id: string, requestId: string, expectedRevision: number) =>
			post(`${path(id)}/forget`, { requestId, expectedRevision }),
		createTask: (input: CreateTask) => post("/api/tasks", input),
		workTask: async (id: string, signal?: AbortSignal) =>
			callJson(transport, taskDetailSchema, path(id), { signal }),
		workTasks: async (
			query: {
				state?: string;
				conversationId?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) =>
			callJson(transport, taskListSchema, withQuery("/api/tasks", query), {
				signal,
			}),
		workTaskEvents: async (
			id: string,
			cursor = "0",
			limit = 50,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				taskEventListSchema,
				withQuery(`${path(id)}/events`, { cursor, limit }),
				{ signal },
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
				grant: OrchestrationGrant;
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
