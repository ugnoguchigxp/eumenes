export const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A bounded read of the original text without cutting a surrogate pair. */
export function textChunkEnd(text: string, start: number): number {
	const end = Math.min(start + 1600, text.length);
	return lowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
}

export function textChunks(text: string): string[] {
	const chunks: string[] = [];
	for (let start = 0; start < text.length;) {
		const end = textChunkEnd(text, start);
		const chunk = text.slice(start, end);
		if (chunk.trim()) chunks.push(chunk);
		start = end;
	}
	return chunks;
}
