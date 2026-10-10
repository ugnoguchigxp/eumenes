/** Small exact spans, never paraphrases. Limits keep the control schema bounded. */
export function requestQuotes(question: string): string[] {
	const result: string[] = [];
	let characters = 0;
	const clauses = question
		.split(/https?:\/\/[^\s<>"'\u0080-\uFFFF]+/gu)
		.flatMap((part) => part.match(/[^。！？\n、]+[。！？\n、]?/gu) ?? [])
		.map((part) => part.trim())
		.filter((part) => part.length >= 8);
	for (const sentence of clauses.length ? clauses : [question]) {
		const points = [...sentence];
		const spans =
			points.length > 160 || sentence.length > 300
				? [points.slice(-80).join(""), points.slice(0, 80).join("")]
				: [sentence];
		for (const span of spans) {
			if (!span || result.includes(span)) continue;
			if (characters + span.length > 600 || result.length >= 6) return result;
			result.push(span);
			characters += span.length;
		}
	}
	return result;
}
