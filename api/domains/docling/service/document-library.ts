import { z } from "zod";
import {
	documentEtag,
	type DocumentCapabilities,
	type DocumentFileConnection,
	type SavedDocument,
} from "../contracts/documents";
import {
	folder,
	libraryPage,
	libraryCommand,
	libraryFeatures,
	type LibraryCommand,
} from "../contracts/library";
import { DocumentFileError } from "./document-error";
type Access = DocumentFileConnection & { binding: string };
type Reply = { response: Response; value: unknown };
export function createDocumentLibrary(io: {
	access(): Access;
	capabilities(signal: AbortSignal): Promise<DocumentCapabilities>;
	request(
		c: Access,
		path: string,
		signal: AbortSignal,
		limit: number,
		init?: RequestInit,
	): Promise<Reply>;
	document(
		c: Access,
		path: string,
		id: string,
		signal: AbortSignal,
		init?: RequestInit,
		status?: number,
	): Promise<SavedDocument>;
}) {
	const read = async (path: string, signal: AbortSignal) =>
		io.request(io.access(), path, signal, 4 * 1024 * 1024);
	async function list(
		input: { namespace: string; path: string; cursor?: string },
		signal: AbortSignal,
	) {
		const c = await io.capabilities(signal);
		if (!libraryFeatures(c).library)
			throw new DocumentFileError("library_unsupported", 409);
		const { response, value } = await read(
				`${c.libraryPath}?${new URLSearchParams({ ...input, limit: String(c.maxPageSize) })}`,
				signal,
			),
			p = libraryPage.safeParse(value);
		if (
			!p.success ||
			response.status !== 200 ||
			p.data.namespace !== input.namespace ||
			p.data.path !== input.path ||
			p.data.entries.length > c.maxPageSize ||
			p.data.entries.some((e) => e.namespace !== input.namespace) ||
			(response.headers.has("etag") &&
				response.headers.get("etag") !== p.data.etag)
		)
			throw new DocumentFileError("docling_invalid_response", 502);
		return p.data;
	}
	async function getFolder(id: string, signal: AbortSignal) {
		const c = await io.capabilities(signal);
		if (!libraryFeatures(c).folders || !/^folder-[a-f0-9]{32}$/.test(id))
			throw new DocumentFileError("library_unsupported", 409);
		const r = await read(`${c.foldersPath}/${encodeURIComponent(id)}`, signal),
			p = folder.safeParse(r.value);
		if (
			!p.success ||
			p.data.id !== id ||
			r.response.headers.get("etag") !== p.data.etag
		)
			throw new DocumentFileError("docling_invalid_response", 502);
		return p.data;
	}
	async function manage(
		raw: LibraryCommand,
		signal: AbortSignal,
		expectedBinding: string,
	) {
		const parsed = libraryCommand.safeParse(raw);
		if (!parsed.success) throw new DocumentFileError("invalid_request", 400);
		const v = parsed.data,
			c = await io.capabilities(signal),
			f = libraryFeatures(c),
			a = io.access();
		if (a.binding !== expectedBinding)
			throw new DocumentFileError("docling_connection_changed", 503);
		if (
			(v.op === "copy" && v.kind === "folder" && !f.folderCopy) ||
			(v.op === "batch" &&
				v.action === "copy" &&
				v.items.some((i) => i.kind === "folder") &&
				!f.folderCopy)
		)
			throw new DocumentFileError("library_unsupported", 409);
		const allowed =
			v.op === "create-folder"
				? f.createFolder
				: v.op === "batch"
					? f.batch &&
						(v.action === "delete"
							? f.delete
							: v.action === "copy"
								? f.copy
								: f.patch)
					: v.op === "patch"
						? f.patch
						: v.op === "copy"
							? f.copy
							: f.delete && (!v.recursive || f.recursiveDelete);
		if (
			!allowed ||
			(v.op !== "batch" &&
				v.op !== "create-folder" &&
				v.kind === "folder" &&
				!f.folders)
		)
			throw new DocumentFileError("library_unsupported", 409);
		if (v.op === "batch" && v.items.length > f.maxBatchItems)
			throw new DocumentFileError("payload_too_large", 413);
		const base =
			v.op === "batch"
				? String(c.operationsPath)
				: v.op === "create-folder" || v.kind === "folder"
					? String(c.foldersPath)
					: c.basePath;
		const path =
			v.op === "batch"
				? base
				: `${base}/${encodeURIComponent(v.id)}${v.op === "copy" ? "/copy" : v.op === "delete" && v.recursive ? "?recursive=true" : ""}`;
		const body =
			v.op === "create-folder"
				? { namespace: v.namespace, path: v.path }
				: v.op === "patch"
					? {
							...(v.path === undefined ? {} : { path: v.path }),
							...(v.title === undefined ? {} : { title: v.title }),
						}
					: v.op === "copy"
						? { id: v.newId, path: v.path }
						: v.op === "batch"
							? { namespace: v.namespace, action: v.action, items: v.items }
							: undefined;
		const text = body === undefined ? undefined : JSON.stringify(body);
		if (text && Buffer.byteLength(text) > c.maxRequestBytes)
			throw new DocumentFileError("payload_too_large", 413);
		const init = {
			method:
				v.op === "create-folder"
					? "PUT"
					: v.op === "patch"
						? "PATCH"
						: v.op === "delete"
							? "DELETE"
							: "POST",
			headers: {
				...(text ? { "Content-Type": "application/json; charset=utf-8" } : {}),
				...(v.op === "create-folder"
					? { "If-None-Match": "*" }
					: { "If-Match": v.etag }),
			},
			...(text === undefined ? {} : { body: text }),
		};
		const id = v.op === "copy" ? v.newId : v.op !== "batch" ? v.id : null,
			status = v.op === "copy" || v.op === "create-folder" ? 201 : 200;
		if (
			v.op !== "batch" &&
			v.op !== "create-folder" &&
			v.kind === "document" &&
			v.op !== "delete"
		)
			return io.document(a, path, id!, signal, init, status);
		const r = await io.request(a, path, signal, 4 * 1024 * 1024, init);
		let valid = false;
		if (v.op === "delete")
			valid = z
				.object({ id: z.literal(v.id), deleted: z.literal(true) })
				.safeParse(r.value).success;
		else if (v.op === "batch") {
			const result = z
				.object({
					namespace: z.literal(v.namespace),
					etag: documentEtag,
					items: z.array(
						z.union([
							z.object({
								kind: z.enum(["document", "folder"]),
								id: z.string(),
								deleted: z.literal(true),
							}),
							z.object({
								kind: z.enum(["document", "folder"]),
								id: z.string(),
								sourceId: z.string(),
								ids: z.record(z.string(), z.string()),
							}),
						]),
					),
				})
				.safeParse(r.value);
			valid =
				result.success &&
				v.items.every((i) =>
					result.data.items.some(
						(r) =>
							r.kind === i.kind &&
							("deleted" in r
								? r.id === i.id
								: r.sourceId === i.id &&
									r.id === (v.action === "copy" ? i.newId : i.id)),
					),
				);
		} else {
			const p = folder.safeParse(r.value);
			valid =
				p.success &&
				p.data.id === id &&
				p.data.namespace === v.namespace &&
				p.data.path === v.path &&
				r.response.headers.get("etag") === p.data.etag;
		}
		if (r.response.status !== status || !valid)
			throw new DocumentFileError(
				"docling_invalid_response",
				r.response.status,
				true,
			);
		return r.value;
	}
	return { listLibrary: list, getFolder, manage };
}
