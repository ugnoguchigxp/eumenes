import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { systemContext } from "../../../infrastructure/system-context";

/** Additions waiting in the short-term layer before the long-term layer is republished. */
export const PENDING_LIMIT = 5;

const LABELS: Record<string, string> = {
	preference: "好み",
	personal_fact: "本人の事実",
	constraint: "制約",
	habit: "習慣",
	goal: "目的",
	decision: "決定",
	open_question: "未解決事項",
	activity: "最近の活動",
	memo: "メモ",
};
const label = (kind: string) => LABELS[kind] ?? kind;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const LONG_TERM_HEADER = systemContext(
	"memory.contexts.context-render.long-term-header",
	{},
);
const TENDENCY_HEADING = "傾向（観察。本人の発言ではない）";
const SHORT_TERM_HEADER = systemContext(
	"memory.contexts.context-render.short-term-header",
	{},
);
const RECENT_HEADING = "最近覚えたこと（長期の一覧に反映前）";

/** State kinds in the order they are written and, when the budget is short, kept. */
const LONG_TERM_KIND_ORDER = [
	"constraint",
	"preference",
	"personal_fact",
	"habit",
];
const rank = (order: readonly string[], kind: string) => {
	const at = order.indexOf(kind);
	return at < 0 ? order.length : at;
};

// ---- period ----

interface PartialDateLike {
	precision: "year" | "month" | "day";
	year: number;
	month?: number;
	day?: number;
}
export interface PeriodLike {
	validity?: { from?: PartialDateLike; until?: PartialDateLike } | undefined;
	validFromMs: number | null;
	validUntilMs: number | null;
}
function partialDate(date: PartialDateLike): string {
	if (date.precision === "year") return `${date.year}年`;
	if (date.precision === "month") return `${date.year}年${date.month}月`;
	return `${date.year}年${date.month}月${date.day}日`;
}
function msDate(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
/** "（2026年9月から）" or "" when the item has no period. Pure: depends on nothing but the item. */
export function formatPeriod(item: PeriodLike): string {
	const from = item.validity?.from
		? partialDate(item.validity.from)
		: item.validFromMs === null
			? undefined
			: msDate(item.validFromMs);
	// validUntilMs is exclusive: the last day covered is the one before.
	const until = item.validity?.until
		? partialDate(item.validity.until)
		: item.validUntilMs === null
			? undefined
			: msDate(item.validUntilMs - 1);
	if (from && until) return `（${from}から${until}まで）`;
	if (from) return `（${from}から）`;
	if (until) return `（${until}まで）`;
	return "";
}

// ---- structure shared by both layers ----

/** The lines of a layer under one heading (the first group of the long-term layer has none). */
export type LayerSection = { heading?: string; items: string[] };
/** A layer before it is written as text: the frame sentence and its lines grouped by heading. */
export type LayerBlock = { header: string; sections: LayerSection[] };

/**
 * The one function that writes a layer as text, so `text` and `sections` cannot drift. `gapBeforeHeading`
 * puts a blank line before each heading (the long-term layer does, the short-term layer does not).
 * An empty block (no sections) is "".
 */
export function layerText(
	block: LayerBlock,
	gapBeforeHeading: boolean,
): string {
	if (block.sections.length === 0) return "";
	const lines = [block.header];
	for (const section of block.sections) {
		if (section.heading !== undefined) {
			if (gapBeforeHeading) lines.push("");
			lines.push(section.heading);
		}
		lines.push(...section.items);
	}
	return lines.join("\n");
}

/**
 * The structure of a layer text stored before windows carried `sections`: the first line is the frame sentence,
 * a line that is not "- ..." starts a section, blank lines are separators. `layerText` writes the result back to
 * the same text.
 */
function layerFromText(text: string, knownHeader: string): LayerBlock {
	if (text === "") return { sections: [], header: "" };
	const header = text.startsWith(knownHeader)
		? knownHeader
		: (text.split("\n", 1)[0] ?? "");
	const sections: LayerSection[] = [];
	for (const line of text.slice(header.length).split("\n")) {
		if (line === "") continue;
		if (line.startsWith("- ")) {
			const last = sections[sections.length - 1];
			if (last) last.items.push(line);
			else sections.push({ items: [line] });
		} else sections.push({ heading: line, items: [] });
	}
	return { header, sections };
}
export const longTermFromText = (text: string) =>
	layerFromText(text, LONG_TERM_HEADER);
export const shortTermFromText = (text: string) =>
	layerFromText(text, SHORT_TERM_HEADER);

// ---- long term (L1) ----

export interface StateLine {
	validUntilMs?: number | null;
	itemId: string;
	revision: number;
	kind: string;
	text: string;
	negated: boolean;
	period: string;
	/** The package's updated_seq: higher is newer. */
	order: number;
}
export interface TendencyLine {
	id: string;
	revision: number;
	text: string;
	/** ISO time: later is newer. */
	order: string;
}
export interface RenderedLongTerm extends LayerBlock {
	text: string;
	manifest: { itemId: string; revision: string }[];
	/** Estimated tokens of `text`. */
	tokens: number;
}

const stateLineText = (line: StateLine) =>
	`- ${label(line.kind)}: ${
		line.negated ? `「${oneLine(line.text)}」ではない` : oneLine(line.text)
	}${line.period}`;

const newestState = (a: StateLine, b: StateLine) =>
	b.order - a.order || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
const newestTendency = (a: TendencyLine, b: TendencyLine) =>
	a.order < b.order ? 1 : a.order > b.order ? -1 : a.id < b.id ? -1 : 1;

function composeLongTerm(
	states: readonly StateLine[],
	tendencies: readonly TendencyLine[],
): LayerBlock {
	const sections: LayerSection[] = [];
	if (states.length > 0)
		sections.push({
			items: [...states]
				.sort(
					(a, b) =>
						rank(LONG_TERM_KIND_ORDER, a.kind) -
							rank(LONG_TERM_KIND_ORDER, b.kind) || newestState(a, b),
				)
				.map(stateLineText),
		});
	if (tendencies.length > 0)
		sections.push({
			heading: TENDENCY_HEADING,
			items: [...tendencies]
				.sort(newestTendency)
				.map((line) => `- ${oneLine(line.text)}`),
		});
	return { header: sections.length === 0 ? "" : LONG_TERM_HEADER, sections };
}
const longTermText = (block: LayerBlock) => layerText(block, true);

/**
 * The long-term layer: every current State line and tendency, in the order the layer is written (kinds with
 * constraint first, tendencies last, newest first within a kind). Same input, same string (it is a prefix of the
 * prompt: a changing value would invalidate the server's KV reuse). The layer has no size limit of its own: the
 * memory and history budget of the window governs, where the conversation is assembled.
 */
export function renderLongTerm(
	states: readonly StateLine[],
	tendencies: readonly TendencyLine[],
): RenderedLongTerm {
	const block = composeLongTerm(states, tendencies);
	const text = longTermText(block);
	return {
		text,
		header: block.header,
		sections: block.sections,
		manifest: [
			...[...states]
				.sort(
					(a, b) =>
						rank(LONG_TERM_KIND_ORDER, a.kind) -
							rank(LONG_TERM_KIND_ORDER, b.kind) || newestState(a, b),
				)
				.map((line) => ({
					itemId: line.itemId,
					revision: String(line.revision),
				})),
			...[...tendencies].sort(newestTendency).map((line) => ({
				itemId: `tendency:${line.id}`,
				revision: String(line.revision),
			})),
		],
		tokens: estimateTextTokens(text),
	};
}

// ---- short term (L2) ----

export interface NoteLine {
	id: string;
	kind: string;
	text: string;
	/** ISO time: later is newer. */
	order: string;
}
export interface RenderedShortTerm extends LayerBlock {
	text: string;
	/** Estimated tokens of `text`: what the continuity guard compares to the memory and history budget. */
	tokens: number;
	/** Recently remembered State not yet in the long-term layer. */
	pendingAdditions: number;
}

/** Section order on screen. */
const SHORT_TERM_SHOW = [
	"goal",
	"decision",
	"open_question",
	"activity",
	"memo",
];
const newestNote = (a: NoteLine, b: NoteLine) =>
	a.order < b.order ? 1 : a.order > b.order ? -1 : a.id < b.id ? -1 : 1;

function composeShortTerm(
	recent: readonly StateLine[],
	notes: readonly NoteLine[],
): LayerBlock {
	const sections: LayerSection[] = [];
	if (recent.length > 0)
		sections.push({
			heading: RECENT_HEADING,
			items: [...recent].sort(newestState).map(stateLineText),
		});
	for (const kind of SHORT_TERM_SHOW) {
		const inKind = notes.filter((note) => note.kind === kind);
		if (inKind.length === 0) continue;
		sections.push({
			heading: label(kind),
			items: [...inKind]
				.sort(newestNote)
				.map((note) => `- ${oneLine(note.text)}`),
		});
	}
	return { header: sections.length === 0 ? "" : SHORT_TERM_HEADER, sections };
}
const shortTermText = (block: LayerBlock) => layerText(block, false);

/** The short-term layer, rebuilt every time: every recent addition and note, with no limit of its own. */
export function renderShortTerm(
	recent: readonly StateLine[],
	notes: readonly NoteLine[],
): RenderedShortTerm {
	const block = composeShortTerm(recent, notes);
	const text = shortTermText(block);
	return {
		text,
		header: block.header,
		sections: block.sections,
		tokens: estimateTextTokens(text),
		pendingAdditions: recent.length,
	};
}

/** Active, in-period continuity items as short-term lines (S2 adds expiry here). */
export function noteLines(
	items: ReadonlyArray<{
		id: string;
		kind: string;
		text: string;
		status: string;
		updatedAt: string;
	}>,
): NoteLine[] {
	return items
		.filter((item) => item.status === "active")
		.map((item) => ({
			id: item.id,
			kind: item.kind,
			text: item.text,
			order: item.updatedAt,
		}));
}
