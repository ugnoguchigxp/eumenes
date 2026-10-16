import { z } from "zod";

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
