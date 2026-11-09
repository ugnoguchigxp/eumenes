import {
	createMarkdown,
	ArchiveFailure,
	type ArchivePort,
	type ArchiveEntry,
} from "../../domains/markdown";
import {
	DocumentFileError,
	libraryFeatures,
	type DocumentSummary,
	type DoclingService,
} from "../../domains/docling";
import type { QueueService } from "../../domains/queue";
import type { SqliteStore } from "../../infrastructure/sqlite";

const entry = (d: DocumentSummary): ArchiveEntry => ({
	sourceId: d.id,
	title: d.title,
	revision: d.etag,
	namespace: d.namespace,
	path: d.path,
	contentDigest: d.contentDigest,
	...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
});
function failure(error: unknown): never {
	if (error instanceof DocumentFileError) {
		const conflict = error.status === 412;
		throw new ArchiveFailure(
			conflict
				? "markdown_archive_conflict"
				: error.uncertain
					? "markdown_archive_unknown"
					: `markdown_${error.code}`,
			conflict ? "conflict" : error.uncertain ? "unknown" : "failed",
			error.status ?? undefined,
		);
	}
	throw new ArchiveFailure("markdown_archive_unknown", "unknown");
}
export function markdownArchive(docling: DoclingService): ArchivePort {
	const files = docling.documents;
	return {
		available: files.available,
		binding: files.binding,
		management: {
			async listLibrary(input, signal) {
				try {
					return await files.listLibrary(input, signal);
				} catch (e) {
					return failure(e);
				}
			},
			async manage(input, signal, binding) {
				try {
					return await files.manage(input, signal, binding);
				} catch (e) {
					return failure(e);
				}
			},
			async getEntry(kind, id, signal) {
				try {
					if (kind === "folder")
						return { ...(await files.getFolder(id, signal)), kind };
					const d = await files.read(id, signal);
					return {
						kind,
						id: d.id,
						namespace: d.namespace,
						path: d.path,
						title: d.title,
						etag: d.etag,
						markdownSha256: d.markdownSha256,
						recoverySha256: d.recoverySha256,
						contentDigest: d.contentDigest,
						...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
					};
				} catch (e) {
					return failure(e);
				}
			},
		},
		async capabilities(signal) {
			try {
				const c = await files.capabilities(signal);
				return {
					maxMarkdownBytes: c.maxMarkdownBytes,
					maxRecoveryBytes: c.maxRecoveryBytes,
					maxRequestBytes: c.maxRequestBytes,
					maxPageSize: c.maxPageSize,
					features: libraryFeatures(c),
				};
			} catch (e) {
				return failure(e);
			}
		},
		async list(signal, cursor) {
			try {
				const page = await files.list(signal, cursor);
				return {
					items: page.documents.map(entry),
					namespaces: page.namespaces,
					nextCursor: page.nextCursor,
				};
			} catch (e) {
				return failure(e);
			}
		},
		async read(sourceId, signal) {
			try {
				const d = await files.read(sourceId, signal);
				return { entry: entry(d), markdown: d.markdown, recovery: d.recovery };
			} catch (e) {
				return failure(e);
			}
		},
		async save(input, signal) {
			try {
				if (!input.remoteRevision) {
					const { namespaces } = await files.list(signal);
					if (!namespaces.includes(input.namespace))
						throw new ArchiveFailure(
							"markdown_namespace_unavailable",
							"failed",
						);
				}
				const body = {
					markdown: input.markdown,
					recovery: input.recovery,
					title: input.title,
				};
				const saved = await files.put(
					input.sourceId,
					input.remoteRevision
						? body
						: { ...body, namespace: input.namespace, path: input.path },
					input.remoteRevision
						? { kind: "update", etag: input.remoteRevision }
						: { kind: "create" },
					signal,
					input.binding,
				);
				return entry(saved);
			} catch (e) {
				if (e instanceof ArchiveFailure) throw e;
				return failure(e);
			}
		},
	};
}
export function buildMarkdown(
	store: SqliteStore,
	queue: QueueService,
	docling: DoclingService,
	publish: () => void,
) {
	return createMarkdown({
		store,
		queue,
		archive: markdownArchive(docling),
		publish,
	});
}
