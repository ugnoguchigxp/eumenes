import type { ExecutionResult } from "../../tool-runtime";
import policy from "./policy.json";

export type Note = { title: string; summary: string; markdown: string };

/**
 * The researcher's text (題 / 要約 / --- / body). Anything else becomes a note with the first line as its title.
 * A Markdown fence around the whole answer is not part of the note.
 */
export function parseNote(raw: string): Note {
	const text = raw
		.trim()
		.replace(/^```[a-z]*\n([\s\S]*)\n```$/u, "$1")
		.trim();
	const lines = text.split("\n");
	// The label can come twice ("要約: 要約: …", seen live 2026-11-11): none of it is the note's words.
	const title = lines[0]?.replace(/^(?:題[:：]\s*)+/u, "").trim() ?? "";
	const summary = lines[1]?.replace(/^(?:要約[:：]\s*)+/u, "").trim() ?? "";
	// The separator belongs on the third line; a rule further down is part of the body.
	const sep = lines[2]?.trim() === "---" ? 2 : -1;
	const body = (sep >= 0 ? lines.slice(sep + 1) : lines.slice(2))
		.join("\n")
		.trim();
	return {
		title: title.slice(0, 80) || "調べたこと",
		summary: summary.slice(0, 200) || body.slice(0, 120),
		markdown: body || text,
	};
}

/** The host of a source address, or null when it is not one (the model writes the body: anything may be there). */
function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname || null;
	} catch {
		return null;
	}
}

/**
 * The addresses the note names as its sources: Markdown links and bare URLs of the body, once each. Parentheses
 * inside an address are kept when balanced (`…/a_(b)`). What is not a valid URL is not a source; the body keeps it.
 */
export function noteSources(markdown: string, fetchedAt: string) {
	const found = new Map<string, string>();
	for (const m of markdown.matchAll(
		/\[([^\]\n]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/gu,
	))
		if (!found.has(m[2]!)) found.set(m[2]!, m[1]!.trim());
	for (const m of markdown.matchAll(
		/https?:\/\/(?:[^\s()<>\]"'、。」』）]|\([^\s()]*\))+/gu,
	)) {
		const url = m[0].replace(/[.,;:!?]+$/u, "");
		if (!found.has(url)) found.set(url, "");
	}
	return [...found]
		.flatMap(([url, title]) => {
			const host = hostOf(url);
			return host ? [{ url, title: title || host }] : [];
		})
		.slice(0, policy.sourcesKept)
		.map(({ url, title }, i) => ({
			sourceId: `s${i + 1}`,
			url,
			title,
			fetchedAt,
		}));
}

/** The task result of a finished note: its title, summary, Markdown body and sources. */
export function noteResult(note: Note, at: number): ExecutionResult {
	return {
		status: "completed",
		title: note.title,
		summary: note.summary,
		fulfilled: [note.summary],
		missing: [],
		refs: [],
		answer: note.markdown,
		sources: noteSources(note.markdown, new Date(at).toISOString()),
		assurance: "model",
	};
}

export function failedResult(
	status: "failed" | "cancelled" | "interrupted",
	code: string,
): ExecutionResult {
	return {
		status,
		summary: "調べものを完了できませんでした。",
		fulfilled: [],
		missing: [],
		refs: [],
		code,
		stopReason: code,
	};
}

/** The date the researcher is told: Japan time with its weekday (2026年11月11日(水)). */
export function today(at: number): string {
	const parts = new Map(
		new Intl.DateTimeFormat("ja-JP", {
			timeZone: "Asia/Tokyo",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			weekday: "short",
		})
			.formatToParts(new Date(at))
			.map((p) => [p.type, p.value]),
	);
	return `${parts.get("year")}年${parts.get("month")}月${parts.get("day")}日(${parts.get("weekday")})`;
}
