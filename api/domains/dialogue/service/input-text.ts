import {
	estimateTextTokens,
	headWithin,
} from "../../../infrastructure/context-budget";

/**
 * The text rules of the conversation's input (the conversation input specification, section 3.2): one-line
 * sentences and `- ` items under a fixed set of `## ` headings, `[name](URL)` links, and no tags or JSON.
 */
export const INPUT_HEADINGS = {
	memory: "## Memory",
	earlier: "## Earlier",
	state: "## State",
	user: "## User",
	notice: "## Host notice",
	candidates: "## Candidates",
	pending: "## Pending",
	retry: "## Retry",
	points: "## Points",
	task: "## Task",
} as const;

/** A result or a notice shows at most this much; the rest is named as left out (sections 8.2 and 9). */
export const RESULT_MAX_TOKENS = 600;
/** A work check reads a result again, with room for what the notice left out. */
export const CHECK_MAX_TOKENS = 1500;

/**
 * Text from outside (the user's words, a record, a result) as data: a line can not open with a heading (`#`
 * becomes `\#`), and a chat template's control strings (`<|…|>`) are taken out, so it forges neither a heading nor
 * a role.
 */
export function dataText(text: string): string {
	return text
		.replace(/<\|[^|>]*\|>/g, "")
		.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
		.replace(/^([ \t]*)#/gm, "$1\\#");
}

/** Data on one line (an item of a list): its line breaks become spaces. */
export function lineText(text: string): string {
	return dataText(text).replace(/\n+/g, " ").trim();
}

/** A `## ` section; null when it has no lines. */
export function section(
	heading: string,
	lines: ReadonlyArray<string>,
): string | null {
	return lines.length ? `${heading}\n${lines.join("\n")}` : null;
}

/** Sections in order, a blank line between them. */
export const joinSections = (parts: ReadonlyArray<string | null>) =>
	parts.filter((part): part is string => !!part).join("\n\n");

/**
 * Lines within a token bound: the head lines are kept, and when some do not fit, the last line says how many were
 * left out and of what (`- 未掲載: 3件（t7）`). The bound counts that line too.
 */
export function fitLines(
	lines: readonly string[],
	maxTokens: number,
	of?: string,
): string[] {
	const total = lines.reduce(
		(sum, line) => sum + estimateTextTokens(line) + 1,
		0,
	);
	if (total <= maxTokens) return [...lines];
	const omitted = (n: number) => `- 未掲載: ${n}件${of ? `（${of}）` : ""}`;
	const kept: string[] = [];
	let used = estimateTextTokens(omitted(lines.length)) + 1;
	for (const line of lines) {
		const cost = estimateTextTokens(line) + 1;
		if (used + cost > maxTokens) {
			// The first line alone over the bound keeps its head: never nothing of the result.
			if (kept.length === 0)
				kept.push(headWithin(line, maxTokens - used - 1).text);
			break;
		}
		kept.push(line);
		used += cost;
	}
	return [...kept, omitted(lines.length - kept.length)];
}

/** `MM-DD` of an ISO time in Asia/Tokyo. */
export function jstDayOf(at: string | number): string {
	const ms = typeof at === "number" ? at : Date.parse(at);
	return new Date(ms + 9 * 3_600_000).toISOString().slice(5, 10);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `10-26（日）19:12` in Asia/Tokyo. */
export function jstNowLine(ms: number): string {
	const jst = new Date(ms + 9 * 3_600_000);
	const iso = jst.toISOString();
	return `${iso.slice(5, 10)}（${WEEKDAYS[jst.getUTCDay()]}）${iso.slice(11, 16)}`;
}

/** A gap as words: `45分`, `3時間`, `2日`. */
export function gapText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}分`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}時間`;
	return `${Math.round(hours / 24)}日`;
}
