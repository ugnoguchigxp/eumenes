import type { AgendaNote, AgendaResearchTicket } from "../../domains/dialogue";
import { NOTES_KEPT } from "./always-on-scope";

/** A note's body is bounded: it is read by the reply and shown, never a store of whole pages. */
const MARKDOWN_MAX = 8000;
const SUMMARY_MAX = 240;

type Result = {
	status?: unknown;
	title?: unknown;
	summary?: unknown;
	answer?: unknown;
	document?: { title?: unknown } | null;
	claims?: Array<{ text?: unknown; status?: unknown }>;
	sources?: Array<{ url?: unknown; title?: unknown }>;
	limitations?: unknown;
	links?: unknown;
};

const text = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

/**
 * The note a returned work becomes: its title (the document the research saved, or the request), a short summary the
 * agent plans with, and the Markdown it reads. Only the adopted result of the work ledger is turned into one.
 */
export function noteFromResult(input: {
	id: string;
	ticket: AgendaResearchTicket;
	summary: string;
	at: number;
}): AgendaNote | null {
	let result: Result | null = null;
	try {
		const parsed: unknown = JSON.parse(input.summary);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			result = parsed as Result;
	} catch {
		result = null;
	}
	// The addresses the agent appended for the researcher are not part of what was asked.
	const request = input.ticket.question
		.replace(/\n?相手が示したURL:.*$/su, "")
		.trim();
	const title =
		text(result?.title) ||
		text(result?.document?.title) ||
		request.replace(/\s+/gu, " ").slice(0, 60) ||
		"調べもの";
	// A note that already names its sources in its text does not get them listed again.
	const answer = text(result?.answer);
	const body = result
		? [
				text(result.answer) || text(result.summary),
				...(result.claims ?? [])
					.map((x) => text(x.text))
					.filter(Boolean)
					.map((x) => `- ${x}`),
				...(Array.isArray(result.limitations)
					? result.limitations.map((x) => `- 限界: ${text(x)}`)
					: []),
				...(result.sources ?? [])
					.filter((s) => !text(s.url) || !answer.includes(text(s.url)))
					.map((s) => [text(s.title), text(s.url)].filter(Boolean).join(" "))
					.filter(Boolean)
					.map((x) => `- 出典: ${x}`),
				...(Array.isArray(result.links)
					? result.links.map((x) => `- 作ったもの: ${text(x)}`)
					: []),
			]
				.filter(Boolean)
				.join("\n")
		: input.summary.trim();
	// A result with nothing to read (a partial report that only says it could not finish) is no note.
	const usable = result
		? !!text(result.answer) ||
			!!(result.claims ?? []).some((x) => text(x.text)) ||
			(Array.isArray(result.links) && result.links.length > 0) ||
			!!text(result.document?.title) ||
			(text(result.summary) !== "" && result.status === "completed")
		: body !== "";
	if (!usable) return null;
	const readable = body || request;
	return {
		id: input.id,
		title,
		// A note that brings its own title brings its own summary: the conclusion the agent plans with.
		summary: (
			(text(result?.title) ? text(result?.summary) : "") ||
			text(result?.answer) ||
			text(result?.summary) ||
			readable
		)
			.replace(/\s+/gu, " ")
			.slice(0, SUMMARY_MAX),
		markdown: `# ${title}\n\n${readable}`.slice(0, MARKDOWN_MAX),
		at: input.at,
		refs: [...input.ticket.refs],
		ticketId: input.ticket.id,
	};
}

/** The newest notes stay in the checkpoint. */
export const keepNotes = (notes: readonly AgendaNote[]) =>
	[...notes].sort((a, b) => a.at - b.at).slice(-NOTES_KEPT);
