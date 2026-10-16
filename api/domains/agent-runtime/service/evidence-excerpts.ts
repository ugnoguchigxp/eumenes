/** Exact, bounded spans of the visible body. IDs are local to a source and model step. */
export function evidenceExcerpts(
	body: string,
	structured = false,
): Array<{ excerptId: string; quote: string; context?: string[] }> {
	if (structured) {
		const spans = evidenceExcerpts(body);
		const headings: Array<{ depth: number; id: string }> = [];
		let table: string | undefined, fence: string | undefined;
		let offset = 0;
		const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		let lineIndex = 0,
			lineStart = 0;
		return spans.map((span) => {
			const start = body.indexOf(span.quote, offset);
			const end = start + span.quote.length;
			offset = end;
			const context = new Set([...headings.map((h) => h.id), table, fence]);
			// Process each original line once, even when a long line crosses spans.
			while (lineIndex < lines.length && lineStart < end) {
				const line = lines[lineIndex]!;
				const id = span.excerptId;
				if (!fence) {
					const heading = /^\s{0,3}(#{1,6})\s/.exec(line);
					if (heading) {
						while (
							headings.length &&
							headings.at(-1)!.depth >= heading[1]!.length
						)
							headings.pop();
						headings.push({ depth: heading[1]!.length, id });
					}
					if (!line.includes("|")) table = undefined;
					else if (/^\s*\|?\s*:?-{3,}/.test(lines[lineIndex + 1] ?? ""))
						table = id;
				}
				if (/^\s*(`{3,}|~{3,})/.test(line)) fence = fence ? undefined : id;
				lineStart += line.length;
				lineIndex++;
			}
			const refs = [...context].filter(
				(id): id is string => !!id && id !== span.excerptId,
			);
			return { ...span, ...(refs.length ? { context: refs } : {}) };
		});
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
