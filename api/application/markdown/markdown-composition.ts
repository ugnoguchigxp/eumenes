import {
	createMarkdown,
	decodeArchive,
	encodeArchive,
	type ArchivePort,
} from "../../domains/markdown";
import type { DoclingService } from "../../domains/docling";
import type { QueueService } from "../../domains/queue";
import type { SqliteStore } from "../../infrastructure/sqlite";

export function markdownArchive(docling: DoclingService): ArchivePort {
	const wiki = docling.wiki;
	return {
		available: wiki.available,
		binding: wiki.binding,
		async list(signal) {
			return (await wiki.list(signal)).map((entry) => ({
				sourceId: entry.id,
				documentId: entry.path.slice(0, -3),
				title: entry.title,
				revision: entry.revision,
				path: entry.path,
			}));
		},
		async read(sourceId, signal) {
			const saved = await wiki.read(sourceId, signal),
				decoded = decodeArchive(saved.text);
			if (saved.article.path !== `${decoded.documentId}.md`)
				throw new Error("markdown_source_invalid");
			return {
				entry: {
					sourceId,
					documentId: decoded.documentId,
					title: decoded.title,
					revision: saved.article.revision,
					path: saved.article.path,
				},
				document: decoded.document,
			};
		},
		async save(input, signal) {
			try {
				const saved = await wiki.save(
					{
						documentId: input.documentId,
						title: input.title,
						text: encodeArchive(
							input.documentId,
							input.title,
							input.document,
							input.markdown,
						),
						sourceId: input.sourceId,
						remoteRevision: input.remoteRevision,
						binding: input.binding,
					},
					signal,
				);
				return {
					sourceId: saved.id,
					documentId: input.documentId,
					title: saved.title,
					revision: saved.revision,
					path: saved.path,
				};
			} catch (error) {
				throw new Error(
					error instanceof Error &&
						error.message === "docling_document_conflict"
						? "markdown_archive_conflict"
						: "markdown_archive_unknown",
				);
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
