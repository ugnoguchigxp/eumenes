import type { Source } from "../../tool-runtime";

/** Exact, bounded spans of the visible body. IDs are local to a source and model step. */
export function evidenceExcerpts(body: string) {
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
