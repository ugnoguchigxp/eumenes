const JST_OFFSET_MS = 9 * 3_600_000;

/**
 * Epoch milliseconds as local ISO 8601 in Japan Standard Time with its offset
 * (`2026-10-18T05:15:00.123+09:00`), so a date is never read in UTC.
 */
export function jstIso(ms: number): string {
	return new Date(ms + JST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** Epoch milliseconds as `YYYY-MM-DD HH:MM:SS` in JST, for people reading logs and reports. */
export function jstDisplay(ms: number): string {
	return jstIso(ms).slice(0, 19).replace("T", " ");
}

/**
 * Parses a time typed by a person or read from a log. Text without a zone (`2026-10-18`,
 * `2026-10-18T05:15`) is JST; text with `Z` or an offset keeps its own zone. NaN when invalid.
 */
export function parseTimeJst(text: string): number {
	const trimmed = text.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
		return Date.parse(`${trimmed}T00:00:00+09:00`);
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed))
		return Date.parse(`${trimmed}+09:00`);
	return Date.parse(trimmed);
}
