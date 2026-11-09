import { z } from "zod";
import {
	editorDocumentSchema,
	libraryFeaturesSchema,
	libraryUpdatedAt,
} from "../api/domains/markdown/contracts";
import { markdownLibraryClient } from "./markdown-library";
import { callJson, json, type Transport } from "./transport";
const entry = z.object({
	sourceId: z.string(),
	title: z.string(),
	revision: z.string(),
	path: z.string(),
	namespace: z.string(),
	contentDigest: z.string(),
	updatedAt: libraryUpdatedAt,
});
const archived = z.object({
	entry,
	markdown: z.string(),
	recovery: z.string(),
});
export const markdownCurrentSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	document: editorDocumentSchema,
	revision: z.number().int(),
	sourceId: z.string().nullable(),
	markdown: z.string().nullable(),
	remote: z
		.object({
			id: z.string(),
			etag: z.string().nullable(),
			namespace: z.string().nullable(),
			path: z.string().nullable(),
		})
		.nullable(),
	conflict: archived.nullable(),
	dirty: z.boolean(),
	saveState: z.string(),
	saveError: z.string().nullable(),
});
export function markdownClient(t: Transport) {
	return {
		...markdownLibraryClient(t),
		markdownCapabilities: (signal?: AbortSignal) =>
			callJson(
				t,
				z.object({
					maxMarkdownBytes: z.number(),
					maxRecoveryBytes: z.number(),
					maxRequestBytes: z.number(),
					maxPageSize: z.number(),
					features: libraryFeaturesSchema.optional(),
				}),
				"/api/markdown/capabilities",
				{ signal },
			),
		markdownStage: (content: unknown, signal?: AbortSignal) =>
			callJson(t, z.object({ id: z.uuid() }), "/api/markdown/inputs", {
				...json(content),
				signal,
			}),
		markdownReconcile: (id: string, signal?: AbortSignal) =>
			callJson(
				t,
				markdownCurrentSchema,
				`/api/markdown/reconcile/${encodeURIComponent(id)}`,
				{ method: "POST", signal },
			),
		markdownLibrary: (signal?: AbortSignal, cursor?: string) =>
			callJson(
				t,
				z.object({
					items: z.array(entry),
					namespaces: z.array(z.string()),
					nextCursor: z.string().nullable(),
				}),
				`/api/markdown/library${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
				{ signal },
			),
		markdownPreview: (id: string, signal?: AbortSignal) =>
			callJson(
				t,
				archived.extend({ document: editorDocumentSchema.nullable() }),
				`/api/markdown/remote/${encodeURIComponent(id)}`,
				{ signal },
			),
		markdownOpen: (
			sourceId: string,
			signal?: AbortSignal,
			options: {
				stageId?: string;
				expectedEtag?: string;
				replaceRevision?: number;
			} = {},
		) =>
			callJson(t, markdownCurrentSchema, "/api/markdown/open", {
				...json({ sourceId, ...options }),
				signal,
			}),
		markdownResolve: (
			documentId: string,
			expectedRevision: number,
			etag: string,
			signal?: AbortSignal,
		) =>
			callJson(t, markdownCurrentSchema, "/api/markdown/resolve", {
				...json({ documentId, expectedRevision, etag }),
				signal,
			}),
	};
}
