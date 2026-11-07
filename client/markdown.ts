import { z } from "zod";
import { editorDocumentSchema } from "../api/domains/markdown/contracts";
import { callJson, json, type Transport } from "./transport";
const current = z.object({
	id: z.uuid(),
	title: z.string(),
	document: editorDocumentSchema,
	revision: z.number().int(),
	sourceId: z.string().nullable(),
	dirty: z.boolean(),
	saveState: z.string(),
	saveError: z.string().nullable(),
});
export function markdownClient(t: Transport) {
	return {
		markdownStage: (content: unknown, signal?: AbortSignal) =>
			callJson(t, z.object({ id: z.uuid() }), "/api/markdown/inputs", {
				...json(content),
				signal,
			}),
		markdownReconcile: (id: string, signal?: AbortSignal) =>
			callJson(
				t,
				current,
				`/api/markdown/reconcile/${encodeURIComponent(id)}`,
				{ method: "POST", signal },
			),
		markdownLibrary: (signal?: AbortSignal) =>
			callJson(
				t,
				z.object({
					items: z.array(
						z.object({
							sourceId: z.string(),
							documentId: z.uuid(),
							title: z.string(),
							revision: z.string(),
							path: z.string(),
						}),
					),
				}),
				"/api/markdown/library",
				{ signal },
			),
		markdownOpen: (sourceId: string, signal?: AbortSignal) =>
			callJson(t, current, "/api/markdown/open", {
				...json({ sourceId }),
				signal,
			}),
	};
}
