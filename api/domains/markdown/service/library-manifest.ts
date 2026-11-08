import { sha256Hex } from "../../../infrastructure/digest";
import type { ArchivePort } from "../contracts";
import type {
	LibraryCommand,
	LibraryEntry,
	ManagementPort,
} from "../contracts/library";
export type Expected = {
	kind: "document" | "folder";
	id: string;
	namespace: string;
	path: string;
	title?: string;
	contentDigest?: string;
	deleted?: boolean;
	sourceId?: string;
	empty?: boolean;
};
export async function captureManifest(
	archive: ArchivePort,
	command: LibraryCommand,
	signal: AbortSignal,
) {
	const port = archive.management!;
	const caps = await archive.capabilities(signal),
		max = caps.features?.maxAffectedItems || 500;
	const root = await port.listLibrary(
		{ namespace: command.namespace, path: "" },
		signal,
	);
	if (command.op === "batch" && root.etag !== command.etag)
		throw new Error("revision_conflict");
	const groups: {
		source: LibraryEntry;
		entries: LibraryEntry[];
		path?: string;
		newId?: string;
	}[] = [];
	if (command.op === "create-folder")
		return {
			before: [] as LibraryEntry[],
			expected: [
				{
					kind: "folder" as const,
					id: command.id,
					namespace: command.namespace,
					path: command.path,
					empty: true,
				},
			],
		};
	const targets = command.op === "batch" ? command.items : [command];
	for (const target of targets) {
		const source = await port.getEntry(target.kind, target.id, signal);
		if (
			source.namespace !== command.namespace ||
			(command.op !== "batch" && source.etag !== command.etag)
		)
			throw new Error("revision_conflict");
		if (source.kind === "folder" && source.hasUnsupportedEntries)
			throw new Error("unsupported_items");
		const entries = [source];
		if (source.kind === "folder") {
			const paths = [source.path];
			for (let i = 0; i < paths.length; i++) {
				let cursor: string | undefined;
				const seen = new Set<string>();
				do {
					const page = await port.listLibrary(
						{
							namespace: source.namespace,
							path: paths[i]!,
							...(cursor ? { cursor } : {}),
						},
						signal,
					);
					if (page.etag !== root.etag) throw new Error("revision_conflict");
					for (const e of page.entries) {
						entries.push(e);
						if (entries.length > max)
							throw new Error("markdown_document_too_large");
						if (e.kind === "folder") {
							if (
								e.path === source.path ||
								!e.path.startsWith(source.path + "/")
							)
								throw new Error("invalid_request");
							if (e.hasUnsupportedEntries) throw new Error("unsupported_items");
							paths.push(e.path);
						}
					}
					cursor = page.nextCursor ?? undefined;
					if (cursor && seen.has(cursor)) throw new Error("invalid_request");
					if (cursor) seen.add(cursor);
				} while (cursor);
			}
			if (command.op === "delete" && !command.recursive && entries.length > 1)
				throw new Error("folder_not_empty");
		}
		groups.push({
			source,
			entries,
			path: "path" in target ? target.path : undefined,
			newId: "newId" in target ? target.newId : undefined,
		});
	}
	// Namespace ETag fences a manifest assembled across several reads, including the last one.
	if (
		(await port.listLibrary({ namespace: command.namespace, path: "" }, signal))
			.etag !== root.etag
	)
		throw new Error("revision_conflict");
	const action = command.op === "batch" ? command.action : command.op;
	const overlapping = (g: (typeof groups)[number]) =>
		groups.some(
			(p) =>
				p !== g &&
				p.source.kind === "folder" &&
				g.source.path.startsWith(p.source.path + "/"),
		);
	if ((action === "move" || action === "copy") && groups.some(overlapping))
		throw new Error("overlapping_selection");
	const selected = groups.filter((g) => !overlapping(g));
	const before = [
		...new Map(
			selected.flatMap((g) => g.entries).map((e) => [e.id, e]),
		).values(),
	];
	if (before.length > max) throw new Error("markdown_document_too_large");
	const expected: Expected[] = selected.flatMap((g) =>
		g.entries.map((e) => {
			const copying = action === "copy",
				id = copying
					? e.id === g.source.id
						? g.newId!
						: e.id.split("-")[0] +
							"-" +
							sha256Hex(g.newId + "\n" + e.id).slice(0, 32)
					: e.id;
			const path = g.path
				? g.path + e.path.slice(g.source.path.length)
				: e.path;
			return {
				kind: e.kind,
				id,
				sourceId: e.id,
				namespace: e.namespace,
				path,
				...(e.kind === "document"
					? {
							title:
								command.op === "patch" && command.title !== undefined
									? command.title
									: e.title,
							contentDigest: e.contentDigest,
						}
					: {}),
				...(action === "delete" ? { deleted: true } : {}),
			};
		}),
	);
	return { before, expected };
}
export async function matchesManifest(
	port: ManagementPort,
	expected: Expected[],
	signal: AbortSignal,
) {
	const metadata: LibraryEntry[] = [];
	const hasFolders = expected.some((e) => e.kind === "folder" && !e.deleted);
	const namespace = expected[0]?.namespace;
	const snapshot =
		hasFolders && namespace
			? await port
					.listLibrary({ namespace, path: "" }, signal)
					.catch(() => null)
			: null;
	if (hasFolders && !snapshot) return null;
	let reads = 0;
	for (const e of expected) {
		try {
			const found = await port.getEntry(e.kind, e.id, signal);
			if (
				e.deleted ||
				found.path !== e.path ||
				found.namespace !== e.namespace ||
				(e.empty &&
					(found.kind !== "folder" ||
						found.documentCount !== 0 ||
						found.folderCount !== 0)) ||
				(e.kind === "document" &&
					(found.kind !== "document" ||
						found.title !== e.title ||
						found.contentDigest !== e.contentDigest))
			)
				return null;
			metadata.push(structuredClone(found));
			if (found.kind === "folder") {
				const children = expected.filter(
						(x) =>
							!x.deleted &&
							x.path.split("/").slice(0, -1).join("/") === found.path,
					),
					seen = new Set<string>(),
					cursors = new Set<string>();
				let cursor: string | undefined;
				do {
					if (++reads > 1500) return null;
					const page = await port.listLibrary(
						{
							namespace: found.namespace,
							path: found.path,
							...(cursor ? { cursor } : {}),
						},
						signal,
					);
					if (page.etag !== snapshot?.etag) return null;
					for (const child of page.entries) {
						if (
							!children.some(
								(x) =>
									x.id === child.id &&
									x.kind === child.kind &&
									x.path === child.path,
							)
						)
							return null;
						seen.add(child.id);
					}
					cursor = page.nextCursor ?? undefined;
					if (cursor && cursors.has(cursor)) return null;
					if (cursor) cursors.add(cursor);
				} while (cursor);
				if (seen.size !== children.length) return null;
			}
		} catch (error) {
			if (
				!e.deleted ||
				!(error instanceof Error) ||
				(!("httpStatus" in error) && !("status" in error)) ||
				("httpStatus" in error
					? error.httpStatus
					: (error as Error & { status: number }).status) !== 404
			)
				return null;
		}
	}
	if (
		snapshot &&
		(
			await port
				.listLibrary({ namespace: snapshot.namespace, path: "" }, signal)
				.catch(() => null)
		)?.etag !== snapshot.etag
	)
		return null;
	return metadata;
}
