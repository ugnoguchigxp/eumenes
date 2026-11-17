import { z } from "zod";
import {
	libraryPage,
	operationView,
	manageInput,
	type LibraryFilesQuery,
} from "../api/domains/markdown/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";
export function markdownLibraryClient(t: Transport) {
	return {
		markdownFiles: (input: LibraryFilesQuery, signal?: AbortSignal) =>
			callJson(t, libraryPage, withQuery("/api/markdown/files", input), {
				signal,
			}),
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
