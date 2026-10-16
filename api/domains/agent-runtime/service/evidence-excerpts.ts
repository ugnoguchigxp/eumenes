import type { Source } from "../../tool-runtime";

/** Exact, bounded spans of the visible body. IDs are local to a source and model step. */
export function evidenceExcerpts(
	body: string,
	structured = false,
): Array<{ excerptId: string; quote: string; context?: string[] }> {
	if (structured) {
		const out: Array<{ excerptId: string; quote: string; context?: string[] }> =
			[];
		const headings: Array<{ depth: number; id: string }> = [];
		let table: string | undefined, fence: string | undefined;
		const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!line.trim()) {
				table = undefined;
				continue;
			}
			const isFence = /^\s*(`{3,}|~{3,})/.test(line);
			const isHeading = !fence && /^\s{0,3}#{1,6}\s/.test(line);
			const depth = isHeading ? line.trimStart().match(/^#+/)![0].length : 0;
			if (isHeading)
				while (headings.length && headings.at(-1)!.depth >= depth)
					headings.pop();
			const isTable = !fence && line.includes("|");
			if (!isTable) table = undefined;
			const header = isTable && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "");
			for (const span of evidenceExcerpts(line)) {
				const excerptId = `e${out.length}`;
				const context = [
					...new Set(
						[headings.at(-1)?.id, table, fence].filter((v): v is string => !!v),
					),
				];
				out.push({
					excerptId,
					quote: span.quote,
					...(context.length ? { context } : {}),
				});
				if (isHeading) headings.push({ depth, id: excerptId });
				if (header) table = excerptId;
				if (isFence) fence = fence ? undefined : excerptId;
			}
		}
		return out;
	}
	const excerpts: Array<{ excerptId: string; quote: string }> = [];
	let start = 0;
	while (start < body.length) {
		let end = Math.min(start + 300, body.length);
		if (end < body.length) {
			const window = body.slice(start, end);
			const boundary = Math.max(
				window.lastIndexOf("\n"),
				window.lastIndexOf(","),
				window.lastIndexOf(" "),
				window.lastIndexOf("。"),
			);
			if (boundary >= 100) end = start + boundary + 1;
			if (/[\uD800-\uDBFF]/u.test(body[end - 1]!)) end--;
		}
		const quote = body.slice(start, end);
		if (quote.trim())
			excerpts.push({ excerptId: `e${excerpts.length}`, quote });
		start = end;
	}
	return excerpts;
}

export function evidenceObservation(source: Source) {
	const { body, ...metadata } = source;
	return { ...metadata, excerpts: evidenceExcerpts(body) };
}
