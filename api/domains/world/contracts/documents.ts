import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

const id = z.string().trim().min(1).max(200);
export const worldDocumentInput = z.strictObject({
	id,
	revision: id,
	title: z.string().trim().min(1).max(240),
	collection: id,
	manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	content: z.string().min(1).max(262144),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type WorldDocumentInput = z.infer<typeof worldDocumentInput>;
/** Flat tool schema; service enforces exactly one of query/documentId. */
export const worldDocumentsInput = z.strictObject({
	query: z.string().trim().min(1).max(120).optional(),
	documentId: id.optional(),
	offset: z.number().int().min(0).max(262144).optional(),
});
export type WorldDocumentScope = { principal: string; scopeKey: string };

/** Owner browsing is separate from the bounded model-facing document lookup. */
export const worldDocumentPageInput = z.strictObject({
	pageIndex: z.coerce.number().int().min(0).max(100000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
		.default(10),
	q: z.string().trim().max(200).default(""),
	sort: z.enum(["id", "title", "collection", "revision"]).default("title"),
	desc: z.boolean().default(false),
});
export type WorldDocumentPageInput = z.infer<typeof worldDocumentPageInput>;
/** HTTP status of each code the document import throws. */
export const errorStatus = {
	document_revision_conflict: 409,
	document_withdrawn: 409,
} as const satisfies Record<string, HttpErrorStatus>;
