import { z } from "zod";
import {
	documentId,
	documentEtag,
	documentSummary,
	type DocumentCapabilities,
} from "./documents";
export const folderId = z.string().regex(/^folder-[a-f0-9]{32}$/);
export const libraryPath = z
	.string()
	.refine(
		(v) =>
			new TextEncoder().encode(v).length <= 2048 &&
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(
				new TextEncoder().encode(v),
			) === v &&
			[...v].length <= 512 &&
			v === v.trim() &&
			!v.includes("\\") &&
			![...v].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127) &&
			v.split("/").every((p) => p && p !== "." && p !== ".."),
	);
export const folder = z.object({
	id: folderId,
	namespace: z.string().min(1),
	path: libraryPath,
	name: z.string().min(1),
	etag: documentEtag,
	documentCount: z.number().int().nonnegative(),
	folderCount: z.number().int().nonnegative(),
	hasUnsupportedEntries: z.boolean(),
});
export const libraryEntry = z.discriminatedUnion("kind", [
	documentSummary.extend({ kind: z.literal("document") }),
	folder.extend({ kind: z.literal("folder") }),
]);
export const libraryPage = z.object({
	namespace: z.string().min(1),
	path: z.string(),
	etag: documentEtag,
	entries: z.array(libraryEntry),
	nextCursor: z.string().min(1).nullable(),
});
export type LibraryEntry = z.infer<typeof libraryEntry>;
export type LibraryPage = z.infer<typeof libraryPage>;
export const libraryItem = z
	.object({
		kind: z.enum(["document", "folder"]),
		id: z.string(),
		path: libraryPath.optional(),
		newId: z.string().optional(),
	})
	.superRefine((v, c) => {
		if (
			!(v.kind === "document" ? documentId : folderId).safeParse(v.id).success
		)
			c.addIssue({ code: "custom", message: "invalid_id" });
		if (
			v.newId &&
			!(v.kind === "document" ? documentId : folderId).safeParse(v.newId)
				.success
		)
			c.addIssue({ code: "custom", message: "invalid_id" });
	});
const target = {
	kind: z.enum(["document", "folder"]),
	id: z.string(),
	namespace: z.string().min(1),
	etag: documentEtag,
};
export const libraryCommand = z
	.discriminatedUnion("op", [
		z.object({
			op: z.literal("create-folder"),
			id: folderId,
			namespace: z.string().min(1),
			path: libraryPath,
		}),
		z.object({
			op: z.literal("patch"),
			...target,
			path: libraryPath.optional(),
			title: z
				.string()
				.min(1)
				.refine(
					(v) =>
						new TextEncoder().encode(v).length <= 4096 &&
						new TextDecoder("utf-8", { ignoreBOM: true }).decode(
							new TextEncoder().encode(v),
						) === v,
				)
				.optional(),
		}),
		z.object({
			op: z.literal("copy"),
			...target,
			newId: z.string(),
			path: libraryPath,
		}),
		z.object({
			op: z.literal("delete"),
			...target,
			recursive: z.boolean().optional(),
		}),
		z.object({
			op: z.literal("batch"),
			namespace: z.string().min(1),
			etag: documentEtag,
			action: z.enum(["move", "copy", "delete"]),
			items: z.array(libraryItem).min(1).max(100),
		}),
	])
	.superRefine((v, c) => {
		if (v.op !== "batch" && v.op !== "create-folder") {
			if (
				!(v.kind === "document" ? documentId : folderId).safeParse(v.id).success
			)
				c.addIssue({ code: "custom", message: "invalid_id" });
			if (
				v.op === "patch" &&
				((!v.path && !v.title) ||
					(v.kind === "folder" && v.title !== undefined))
			)
				c.addIssue({ code: "custom", message: "invalid_patch" });
			if (
				v.op === "copy" &&
				!(v.kind === "document" ? documentId : folderId).safeParse(v.newId)
					.success
			)
				c.addIssue({ code: "custom", message: "invalid_id" });
		}
		const items = v.op === "batch" ? v.items : [];
		if (
			items.some(
				(i) =>
					v.op === "batch" &&
					v.action !== "delete" &&
					(!i.path || (v.action === "copy" && !i.newId)),
			)
		)
			c.addIssue({ code: "custom", message: "invalid_items" });
		for (const i of v.op === "batch"
			? items
			: v.op === "create-folder"
				? []
				: [v])
			if (
				i.kind === "document" &&
				"path" in i &&
				i.path &&
				!/\.(md|markdown)$/.test(i.path)
			)
				c.addIssue({ code: "custom", message: "invalid_document_path" });
	});
export type LibraryCommand = z.infer<typeof libraryCommand>;
export function libraryFeatures(c: DocumentCapabilities) {
	const ops = Array.isArray(c.libraryOperations) ? c.libraryOperations : [],
		method = (m: string) => c.methods.includes(m),
		positive = (v: unknown) =>
			typeof v === "number" && Number.isSafeInteger(v) && v > 0;
	const library = c.libraryPath === "/v1/docling/library",
		folders = library && c.foldersPath === "/v1/docling/folders";
	return {
		library,
		folders,
		patch: method("PATCH") && ops.includes("rename") && ops.includes("move"),
		copy: method("POST") && ops.includes("copy"),
		delete: method("DELETE") && typeof c.delete === "string",
		createFolder: folders && method("PUT"),
		recursiveDelete:
			folders && method("DELETE") && ops.includes("recursive-delete"),
		folderCopy:
			folders &&
			method("POST") &&
			ops.includes("copy") &&
			typeof c.folderCopyIds === "string" &&
			positive(c.maxAffectedItems) &&
			positive(c.maxCopyBytes),
		batch:
			library &&
			["move", "copy", "delete"].every((op) => ops.includes(op)) &&
			c.operationsPath === "/v1/docling/operations" &&
			method("POST") &&
			positive(c.maxBatchItems) &&
			positive(c.maxAffectedItems) &&
			positive(c.maxCopyBytes),
		maxBatchItems: positive(c.maxBatchItems)
			? Math.min(c.maxBatchItems as number, 100)
			: 0,
		maxAffectedItems: positive(c.maxAffectedItems)
			? Math.min(c.maxAffectedItems as number, 500)
			: 0,
		maxCopyBytes: positive(c.maxCopyBytes) ? (c.maxCopyBytes as number) : 0,
	};
}
