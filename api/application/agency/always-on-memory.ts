import type { AgendaNote, AgendaResearchTicket } from "../../domains/dialogue";
import { NOTES_KEPT } from "./always-on-scope";

const SUMMARY_MAX = 240;

type Source = {
	url?: unknown;
	title?: unknown;
	kind?: unknown;
	/** An archived document's version and the position of the passage in its original text. */
	revision?: unknown;
	start?: unknown;
	end?: unknown;
	/** A source inspection's place in the code. */
	location?: {
		path?: unknown;
		symbol?: unknown;
		commit?: unknown;
		startLine?: unknown;
		endLine?: unknown;
	} | null;
};

type Result = {
	status?: unknown;
	title?: unknown;
	summary?: unknown;
	answer?: unknown;
	document?: { title?: unknown } | null;
	claims?: Array<{ text?: unknown; status?: unknown }>;
	sources?: Source[];
	limitations?: unknown;
	/** The cited excerpts a source inspection shows: they stand in for the answer in the note. */
	displayAnswer?: unknown;
	/** An evidence report (archive research, source inspection): its own claims and sources, as the owner saved them. */
	report?: {
		claims?: Array<{ text?: unknown; status?: unknown }>;
		sources?: Source[];
		limitations?: unknown;
	} | null;
	links?: unknown;
	/** An assignment's report (a development toolchain): what it did and what is left. */
	fulfilled?: unknown;
	missing?: unknown;
};

const lines = (value: unknown) =>
	Array.isArray(value) ? value.map(text).filter(Boolean) : [];

/**
 * The work report an assignment comes back as: the same kind of note as a research, so the agent reads, shows and
 * tells it the same way. Sections without content are left out.
 */
function reportNote(input: {
	id: string;
	ticket: AgendaResearchTicket;
	result: Result | null;
	summary: string;
	at: number;
}): AgendaNote | null {
	const { result } = input;
	// The addresses the agent appended for the assignee are not part of what was asked.
	const request = input.ticket.question
		.replace(/\n?相手が示したURL:.*$/su, "")
		.trim();
	const summary = text(result?.summary) || (result ? "" : input.summary.trim());
	const fulfilled = lines(result?.fulfilled);
	const missing = lines(result?.missing);
	const links = lines(result?.links);
	if (!summary && !fulfilled.length && !missing.length && !links.length)
		return null;
	const title = `作業報告: ${request.replace(/\s+/gu, " ").slice(0, 50)}`;
	const section = (heading: string, items: string[]) =>
		items.length ? [`## ${heading}`, ...items.map((x) => `- ${x}`)] : [];
	const body = [
		"## 依頼",
		request,
		...(summary ? ["## 結果", summary] : []),
		...section("達成したこと", fulfilled),
		...section("残ったこと", missing),
		...section("作ったもの", links),
	].join("\n\n");
	return {
		id: input.id,
		title,
		summary: (summary || fulfilled.join(" ") || request)
			.replace(/\s+/gu, " ")
			.slice(0, SUMMARY_MAX),
		markdown: `# ${title}\n\n${body}`,
		at: input.at,
		refs: [...input.ticket.refs],
		ticketId: input.ticket.id,
		inputs: [...input.ticket.inputs],
	};
}

const text = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

/** Where a note's claim came from, in words: the page, the archived document's version and position, or the code. */
function sourceLabel(source: Source): string {
	if (text(source.kind) === "archive_document")
		return `保存文書「${text(source.title)}」版 ${text(source.revision)}、原文位置 ${String(source.start)}–${String(source.end)}`;
	const place = source.location;
	if (place && text(place.path)) {
		const symbol = text(place.symbol);
		const commit = text(place.commit);
		return `コード ${text(place.path)} ${String(place.startLine)}–${String(place.endLine)}行目${symbol ? `（${symbol}）` : ""}${commit ? ` ${commit.slice(0, 12)}` : ""}`;
	}
	return [text(source.title), text(source.url)].filter(Boolean).join(" ");
}

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
	if (input.ticket.assignment) return reportNote({ ...input, result });
	// The addresses the agent appended for the researcher are not part of what was asked.
	const request = input.ticket.question
		.replace(/\n?相手が示したURL:.*$/su, "")
		.trim();
	const title =
		text(result?.title) ||
		text(result?.document?.title) ||
		request.replace(/\s+/gu, " ").slice(0, 60) ||
		"調べもの";
	// The owner's own report holds the claims and sources a result does not repeat at its top.
	const claims = result?.claims ?? result?.report?.claims ?? [];
	const sources = result?.sources ?? result?.report?.sources ?? [];
	const limitations = result?.limitations ?? result?.report?.limitations;
	// The cited excerpts of a source inspection are what it shows: they stand in for its answer and its claims.
	const shown = text(result?.displayAnswer);
	// A note that already names its sources in its text does not get them listed again.
	const answer = shown || text(result?.answer);
	const body = result
		? [
				answer || text(result.summary),
				...(shown ? [] : claims)
					.map((x) => text(x.text))
					.filter(Boolean)
					.map((x) => `- ${x}`),
				...(Array.isArray(limitations)
					? limitations.map((x) => `- 限界: ${text(x)}`)
					: []),
				...sources
					.filter((s) => !text(s.url) || !answer.includes(text(s.url)))
					.map(sourceLabel)
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
		? !!answer ||
			claims.some((x) => text(x.text)) ||
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
		markdown: `# ${title}\n\n${readable}`,
		at: input.at,
		refs: [...input.ticket.refs],
		ticketId: input.ticket.id,
		inputs: [...input.ticket.inputs],
	};
}

/** The document keeps the original; the checkpoint needs only a bounded preview. */
export function withNoteDocument(
	note: AgendaNote,
	documentId: string,
): AgendaNote {
	const limit = 8000;
	const omission = "\n\n（全文は保存文書にあります。）";
	return {
		...note,
		documentId,
		markdown:
			note.markdown.length <= limit
				? note.markdown
				: note.markdown.slice(0, limit - omission.length) + omission,
	};
}

/** The newest notes stay in the checkpoint. */
export const keepNotes = (notes: readonly AgendaNote[]) =>
	[...notes].sort((a, b) => a.at - b.at).slice(-NOTES_KEPT);
