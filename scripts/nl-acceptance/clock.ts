/**
 * Remaining-time readings in an accessibility snapshot. The UI under test is unknown to the
 * judge, so every plausible clock rendering is a candidate; a reading counts only when it
 * agrees with the host's remaining time.
 */
export function clockCandidates(text: string): number[] {
	const found = new Set<number>();
	for (const m of text.matchAll(
		/(?<![\d:])(\d{1,3}):(\d{2})(?::(\d{2}))?(?![\d:])/g,
	)) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (b > 59) continue;
		if (m[3] !== undefined) {
			const c = Number(m[3]);
			if (c <= 59) found.add(a * 3600 + b * 60 + c);
		} else {
			// mm:ss or hh:mm
			found.add(a * 60 + b);
			found.add(a * 3600 + b * 60);
		}
	}
	for (const m of text.matchAll(
		/(?:(\d{1,3})\s*時間)?\s*(?:(\d{1,3})\s*分)?\s*(?:(\d{1,3})\s*秒)?/g,
	)) {
		if (m[1] === undefined && m[2] === undefined && m[3] === undefined)
			continue;
		found.add(
			Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0),
		);
	}
	return [...found];
}

/** The candidate closest to `value` within `tolerance`, or null. */
export function closestWithin(
	candidates: readonly number[],
	value: number,
	tolerance: number,
): number | null {
	let best: number | null = null;
	for (const candidate of candidates)
		if (
			Math.abs(candidate - value) <= tolerance &&
			(best === null || Math.abs(candidate - value) < Math.abs(best - value))
		)
			best = candidate;
	return best;
}
