import { z } from "zod";

export const documentId = z.string().regex(/^wiki-[a-f0-9]{32}$/);
export const documentEtag = z.string().regex(/^"[a-f0-9]{64}"$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const documentCapabilities = z.object({
	contractVersion: z.literal("larm.docling-files.v1"),
	basePath: z.literal("/v1/docling/documents"),
	requiresDocling: z.literal(false),
	methods: z
		.array(z.string())
		.refine((v) => v.includes("GET") && v.includes("PUT")),
	delete: z.unknown().optional(),
	libraryPath: z.unknown().optional(),
	foldersPath: z.unknown().optional(),
	operationsPath: z.unknown().optional(),
	libraryOperations: z.unknown().optional(),
	maxBatchItems: z.unknown().optional(),
	maxAffectedItems: z.unknown().optional(),
	maxCopyBytes: z.unknown().optional(),
	folderCopyIds: z.unknown().optional(),
	maxRequestBytes: z.number().int().positive().safe(),
	maxMarkdownBytes: z.number().int().positive().safe(),
	maxRecoveryBytes: z.number().int().positive().safe(),
	maxPageSize: z.number().int().positive().max(100),
	contentDigest: z.literal(
		"sha256(ascii(markdownSha256 + LF + recoverySha256))",
	),
});
export const documentSummary = z.object({
	id: documentId,
	namespace: z.string().min(1),
	path: z.string().min(1),
	title: z.string().min(1),
	etag: documentEtag,
	markdownSha256: digest,
	recoverySha256: digest,
	contentDigest: digest,
});
export const savedDocument = documentSummary.extend({
	markdown: z.string(),
	recovery: z.string(),
});
export const documentList = z.object({
	documents: z.array(documentSummary),
	namespaces: z.array(z.string().min(1)),
	nextCursor: z.string().min(1).nullable(),
});
export type DocumentCapabilities = z.infer<typeof documentCapabilities>;
export type DocumentSummary = z.infer<typeof documentSummary>;
export type SavedDocument = z.infer<typeof savedDocument>;
export type DocumentCondition =
	{ kind: "create" } | { kind: "update"; etag: string };
export type DocumentWrite = {
	markdown: string;
	recovery: string;
	title?: string;
	namespace?: string;
	path?: string;
};
export type DocumentFileConnection = { baseUrl: string; credential: string };
