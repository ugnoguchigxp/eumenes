import { z } from "zod";

export const limits = {
	bytes: 8 * 1024 * 1024,
	originalChars: 8 * 1024 * 1024,
	nodes: 5000,
	depth: 32,
} as const;
export type JsonValue =
	string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EditorNode = { [key: string]: JsonValue };
const nodeTypes = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"hr",
	"a",
	"img",
	"code_block",
	"code_line",
	"code_syntax",
	"table",
	"tr",
	"td",
	"th",
	"equation",
	"inline_equation",
	"footnoteDefinition",
	"footnoteReference",
	"footnoteInput",
	"callout",
	"toggle",
	"toc",
	"column_group",
	"column",
]);
function nodesValid(nodes: unknown[]): boolean {
	let count = 0;
	function visit(value: unknown, depth: number): boolean {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			++count > limits.nodes ||
			depth > limits.depth
		)
			return false;
		const node = value as Record<string, unknown>;
		if ("text" in node)
			return typeof node.text === "string" && !("children" in node);
		if (
			typeof node.type !== "string" ||
			!nodeTypes.has(node.type) ||
			!Array.isArray(node.children) ||
			!node.children.length
		)
			return false;
		if (
			node.url !== undefined &&
			(typeof node.url !== "string" || !/^(https?:|mailto:)/i.test(node.url))
		)
			return false;
		return node.children.every((child) => visit(child, depth + 1));
	}
	return nodes.every(
		(node) =>
			!!node &&
			typeof node === "object" &&
			typeof (node as Record<string, unknown>).type === "string" &&
			Array.isArray((node as Record<string, unknown>).children) &&
			visit(node, 0),
	);
}
export const editorDocumentSchema = z
	.strictObject({
		formatVersion: z.literal(1),
		nodes: z.array(z.record(z.string(), z.json())).min(1).max(limits.nodes),
		originalMarkdown: z.string().max(limits.originalChars).nullable(),
	})
	.superRefine((document, ctx) => {
		if (!nodesValid(document.nodes))
			ctx.addIssue({
				code: "custom",
				path: ["nodes"],
				message: "invalid_editor_nodes",
			});
		if (
			new TextEncoder().encode(JSON.stringify(document)).length > limits.bytes
		)
			ctx.addIssue({ code: "custom", message: "document_too_large" });
	});
export type EditorDocument = z.infer<typeof editorDocumentSchema>;
export const emptyDocument = (): EditorDocument => ({
	formatVersion: 1,
	nodes: [{ type: "p", children: [{ text: "" }] }],
	originalMarkdown: null,
});
export const id = z.string().uuid();
export const title = z
	.string()
	.min(1)
	.refine((v) => new TextEncoder().encode(v).length <= 4096);
export const applyInput = z.strictObject({
	documentId: id,
	expectedRevision: z.number().int().positive(),
	title,
	stageId: id,
});
export const newInput = z.strictObject({ title, stageId: id });
export const saveInput = z.strictObject({
	documentId: id,
	expectedRevision: z.number().int().positive(),
	stageId: id,
});
export const openInput = z.strictObject({
	sourceId: z.string().regex(/^wiki-[a-f0-9]{32}$/),
	stageId: id.optional(),
	expectedEtag: z
		.string()
		.regex(/^"[a-f0-9]{64}"$/)
		.optional(),
	replaceRevision: z.number().int().positive().optional(),
});
export const resolveInput = z.strictObject({
	documentId: id,
	expectedRevision: z.number().int().positive(),
	etag: z.string().regex(/^"[a-f0-9]{64}"$/),
});
export function checkDocument(text: string) {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {
			ok: false as const,
			code: "document_parse_failed",
			issues: [{ path: "root", rule: "json" }],
			fixes: [] as string[],
		};
	}
	const result = editorDocumentSchema.safeParse(value);
	return result.success
		? { ok: true as const, value: result.data, fixes: [] as string[] }
		: {
				ok: false as const,
				code: "markdown_document_invalid",
				issues: result.error.issues.slice(0, 8).map((issue) => ({
					path: issue.path.join(".") || "root",
					rule: issue.code,
				})),
				fixes: [] as string[],
			};
}
export type ArchiveEntry = {
	sourceId: string;
	documentId?: string;
	title: string;
	revision: string;
	path: string;
	namespace: string;
	contentDigest: string;
};
export type ArchivedDocument = {
	entry: ArchiveEntry;
	markdown: string;
	recovery: string;
};
export type ArchiveSave = {
	documentId: string;
	title: string;
	markdown: string;
	recovery: string;
	sourceId: string;
	remoteRevision: string | null;
	binding: string;
	namespace: string;
	path: string;
	contentDigest: string;
};
export class ArchiveFailure extends Error {
	constructor(
		readonly code: string,
		readonly outcome: "unknown" | "conflict" | "failed",
		readonly httpStatus?: number,
	) {
		super(code);
	}
}
export type ArchivePort = {
	available(): boolean;
	binding(): string | null;
	capabilities(signal: AbortSignal): Promise<{
		maxMarkdownBytes: number;
		maxRecoveryBytes: number;
		maxRequestBytes: number;
		maxPageSize: number;
	}>;
	list(
		signal: AbortSignal,
		cursor?: string,
	): Promise<{
		items: ArchiveEntry[];
		namespaces: string[];
		nextCursor: string | null;
	}>;
	read(sourceId: string, signal: AbortSignal): Promise<ArchivedDocument>;
	save(input: ArchiveSave, signal: AbortSignal): Promise<ArchiveEntry>;
};
export const errorStatus = {
	markdown_document_too_large: 422,
	markdown_not_found: 404,
	markdown_document_invalid: 422,
	markdown_apply_invalid: 422,
	markdown_save_in_progress: 409,
	markdown_archive_unavailable: 503,
	markdown_archive_failed: 502,
	markdown_archive_unknown: 502,
	markdown_archive_conflict: 409,
	markdown_source_invalid: 422,
	revision_conflict: 409,
	turn_not_current: 409,
	work_busy: 409,
} as const;

export const stageInput = z.strictObject({
	document: editorDocumentSchema,
	markdown: z
		.string()
		.refine((v) => new TextEncoder().encode(v).length <= 8 * 1024 * 1024)
		.optional(),
});
