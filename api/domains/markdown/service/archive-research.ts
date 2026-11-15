import type { ArchivePort } from "../contracts";

const MAX_MATCHES = 6;
const CHUNK = 1600;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/** Bounded reads of the original Markdown. This path never opens a workspace. */
export function createArchiveResearch(archive: ArchivePort) {
	function expectBinding(binding: string) {
		if (archive.binding() !== binding)
			throw new Error("markdown_archive_binding_changed");
	}
	return {
		binding: archive.binding,
		async search(
			binding: string,
			terms: readonly string[],
			cursor: string | undefined,
			signal: AbortSignal,
		) {
			expectBinding(binding);
			const page = await archive.list(signal, cursor);
			signal.throwIfAborted();
			expectBinding(binding);
			const keys = terms.map(normalize);
			const matches = page.items.filter(
				(entry) =>
					!keys.length ||
					keys.some((key) =>
						normalize(
							`${entry.title}\n${entry.namespace}\n${entry.path}`,
						).includes(key),
					),
			);
			return {
				items: matches.slice(0, MAX_MATCHES),
				omitted: matches.length - Math.min(matches.length, MAX_MATCHES),
				scanned: page.items.length,
				nextCursor: page.nextCursor,
			};
		},
		async read(
			input: {
				binding: string;
				sourceId: string;
				revision: string;
				offset: number;
			},
			signal: AbortSignal,
		) {
			expectBinding(input.binding);
			const document = await archive.read(input.sourceId, signal);
			signal.throwIfAborted();
			expectBinding(input.binding);
			if (
				document.entry.sourceId !== input.sourceId ||
				document.entry.revision !== input.revision
			)
				throw new Error("revision_conflict");
			const markdown = document.markdown.replaceAll("\r\n", "\n");
			const start = input.offset;
			if (
				!Number.isSafeInteger(start) ||
				start < 0 ||
				start > markdown.length ||
				lowSurrogate(markdown.charCodeAt(start))
			)
				throw new Error("markdown_range_invalid");
			let end = Math.min(start + CHUNK, markdown.length);
			if (lowSurrogate(markdown.charCodeAt(end))) end--;
			return {
				title: document.entry.title,
				body: markdown.slice(start, end),
				start,
				end,
				nextOffset: end < markdown.length ? end : null,
			};
		},
	};
}

const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
