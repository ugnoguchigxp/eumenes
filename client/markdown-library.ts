import { z } from "zod";
import {
	libraryPage,
	operationView,
	manageInput,
} from "../api/domains/markdown/contracts";
import { callJson, json, type Transport } from "./transport";
export function markdownLibraryClient(t: Transport) {
	return {
		markdownFiles: (
			input: { namespace: string; path: string; cursor?: string },
			signal?: AbortSignal,
		) =>
			callJson(
				t,
				libraryPage,
				`/api/markdown/files?${new URLSearchParams(input)}`,
				{ signal },
			),
		markdownOperations: (signal?: AbortSignal) =>
			callJson(t, z.array(operationView), "/api/markdown/management", {
				signal,
			}),
		markdownStageManagement: (input: z.infer<typeof manageInput>) =>
			callJson(
				t,
				z.object({ id: z.uuid() }),
				"/api/markdown/management-inputs",
				json(input),
			),
		markdownManage: (
			input: z.infer<typeof manageInput> | { stageId: string },
			signal?: AbortSignal,
		) =>
			callJson(t, operationView, "/api/markdown/management", {
				...json(input),
				signal,
			}),
		markdownCheck: (id: string, signal?: AbortSignal) =>
			callJson(
				t,
				operationView,
				`/api/markdown/management/${encodeURIComponent(id)}/check`,
				{ method: "POST", signal },
			),
	};
}
