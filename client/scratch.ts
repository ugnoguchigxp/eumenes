import { z } from "zod";
import { scratchMime } from "../api/domains/scratch/contracts";
import { callJson, withQuery, type Transport } from "./transport";

/** `GET /api/scratch/:id` and the upload's answer (spec/server-scratch-cache-design-2026-11-07.md §10). */
export const scratchItemSchema = z.looseObject({
	id: z.uuid(),
	uri: z.string(),
	conversationId: z.string(),
	name: z.string(),
	mime: scratchMime,
	bytes: z.number().int().nonnegative(),
	origin: z.enum(["attached", "pasted", "written"]),
	maker: z.string(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
	contentUrl: z.string(),
	createdAt: z.string(),
	usedAt: z.string(),
});
export type ScratchItemView = z.infer<typeof scratchItemSchema>;

export function scratchClient(transport: Transport) {
	return {
		/** The user's file as a shared file of the conversation; `requestId` becomes its id. */
		uploadScratchFile: async (
			conversationId: string,
			requestId: string,
			file: File,
		) => {
			const body = new FormData();
			body.set("file", file);
			return callJson(
				transport,
				scratchItemSchema,
				withQuery(
					`/api/conversations/${encodeURIComponent(conversationId)}/scratch`,
					{ requestId },
				),
				{ method: "POST", body },
			);
		},
		scratchItem: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				scratchItemSchema,
				`/api/scratch/${encodeURIComponent(id)}`,
				{ signal },
			),
		scratchContent: async (id: string, signal?: AbortSignal) =>
			(
				await transport.call(`/api/scratch/${encodeURIComponent(id)}/content`, {
					signal,
				})
			).blob(),
	};
}
