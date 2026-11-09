import { z } from "zod";
export const libraryUpdatedAt = z.iso
	.datetime({ offset: true })
	.optional()
	.catch(undefined);
const documentId = z.string().regex(/^wiki-[a-f0-9]{32}$/),
	documentEtag = z.string().regex(/^"[a-f0-9]{64}"$/);
const documentSummary = z.object({
	id: documentId,
	namespace: z.string().min(1),
	path: z.string(),
	title: z.string(),
	etag: documentEtag,
	markdownSha256: z.string(),
	recoverySha256: z.string(),
	contentDigest: z.string(),
	updatedAt: libraryUpdatedAt,
});
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
	updatedAt: libraryUpdatedAt,
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

export const libraryFeaturesSchema = z.object({
	library: z.boolean(),
	folders: z.boolean(),
	folderCopy: z.boolean().optional(),
	patch: z.boolean(),
	copy: z.boolean(),
	delete: z.boolean(),
	createFolder: z.boolean(),
	recursiveDelete: z.boolean(),
	batch: z.boolean(),
	maxBatchItems: z.number(),
	maxAffectedItems: z.number(),
	maxCopyBytes: z.number(),
});
export type LibraryFeatures = z.infer<typeof libraryFeaturesSchema>;
export type ManagementPort = {
	listLibrary(
		input: { namespace: string; path: string; cursor?: string },
		signal: AbortSignal,
	): Promise<LibraryPage>;
	getEntry(
		kind: "document" | "folder",
		id: string,
		signal: AbortSignal,
	): Promise<LibraryEntry>;
	manage(
		input: LibraryCommand,
		signal: AbortSignal,
		binding: string,
	): Promise<unknown>;
};
export const manageInput = z.object({
	requestId: z.uuid(),
	command: libraryCommand,
});
export const operationView = z.object({
	id: z.uuid(),
	state: z.enum(["unknown", "applied", "confirmed", "conflict", "failed"]),
	code: z.string().nullable(),
	command: libraryCommand,
	removedWorkspaceIds: z.array(z.string()),
});
export type OperationView = z.infer<typeof operationView>;
