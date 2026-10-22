import { systemContext } from "../../../infrastructure/system-context";
import type { Database } from "bun:sqlite";
import { estimateTextTokens, type ContextBlock } from "../../inference";
import type {
	AgencyContext,
	AgencyContextUtterance,
	AgencyLayerPort,
} from "../contracts";
import { omitted } from "./context-fit";

const AGENCY_FRAME = systemContext(
	"dialogue.contexts.agency-layer.agency-frame",
	{},
);
const UTTERANCES_HEADING = systemContext(
	"dialogue.contexts.agency-layer.agency-utterances-heading",
	{},
);
const INTERESTS_HEADING = systemContext(
	"dialogue.contexts.agency-layer.agency-interests-heading",
	{},
);
const PARTIAL_MARK = systemContext(
	"dialogue.contexts.agency-layer.agency-partial-mark",
	{},
);

/** The size of the whole layer (frame, headings and lines) in estimated tokens; the oldest utterances go first. */
export const AGENCY_LAYER_MAX_TOKENS = 600;

/** One line: whitespace collapsed (a line cannot start a new line of its own). */
const oneLine = (text: string) => `- ${text.replace(/\s+/g, " ").trim()}`;

const utteranceLine = (u: AgencyContextUtterance, text = u.text) =>
	u.heard === "partial" ? `${oneLine(text)}${PARTIAL_MARK}` : oneLine(text);

const omittedLine = (count: number) =>
	`- ${systemContext("dialogue.contexts.agency-layer.agency-omitted", { count: String(count) })}`;

/** The first characters of a text with an omission mark, as many as keep `fits` true. */
function clipText(text: string, fits: (text: string) => boolean): string {
	const chars = [...text];
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = `${chars.slice(0, mid).join("")}${omitted(chars.length - mid)}`;
		if (fits(candidate)) low = mid;
		else high = mid - 1;
	}
	return `${chars.slice(0, low).join("")}${omitted(chars.length - low)}`;
}

/**
 * The agency block of the volatile part: what the assistant said on its own since the user's last message (the
 * messages of the agency have no run, so the history does not hold them) and its standing interests. Reference
 * data, never instructions. Null without a port, and when the port returns nothing to show. Over
 * `AGENCY_LAYER_MAX_TOKENS` the oldest utterances are dropped first and the count is stated; the newest one is
 * never dropped (cut with an omission mark if it alone is too long).
 */
export function renderAgencyLayer(
	port: AgencyLayerPort | undefined,
	db: Database,
	conversationId: string,
): ContextBlock | null {
	if (!port) return null;
	const context: AgencyContext | null = port.recentForContextInTransaction(
		db,
		conversationId,
	);
	if (!context) return null;
	const utterances = context.utterances.filter((u) => u.text.trim() !== "");
	const interests = context.interests
		.filter((text) => text.trim() !== "")
		.map(oneLine);
	if (utterances.length === 0 && interests.length === 0) return null;

	const lines = utterances.map((u) => utteranceLine(u));
	// The size of a layer that shows the last `count` utterances (and says how many were left out).
	const build = (kept: string[], dropped: number) => {
		const items = dropped > 0 ? [omittedLine(dropped), ...kept] : kept;
		const sections: Array<{ heading: string; items: string[] }> = [
			...(items.length ? [{ heading: UTTERANCES_HEADING, items }] : []),
			...(interests.length
				? [{ heading: INTERESTS_HEADING, items: interests }]
				: []),
		];
		return sections;
	};
	const tokens = (sections: ReturnType<typeof build>) =>
		estimateTextTokens(
			[AGENCY_FRAME, ...sections.flatMap((s) => [s.heading, ...s.items])].join(
				"\n",
			),
		);

	let dropped = 0;
	while (
		lines.length - dropped > 1 &&
		tokens(build(lines.slice(dropped), dropped)) > AGENCY_LAYER_MAX_TOKENS
	)
		dropped++;
	let kept = lines.slice(dropped);
	if (
		kept.length === 1 &&
		tokens(build(kept, dropped)) > AGENCY_LAYER_MAX_TOKENS
	) {
		const newest = utterances[utterances.length - 1]!;
		const text = clipText(
			newest.text.replace(/\s+/g, " ").trim(),
			(candidate) =>
				tokens(build([utteranceLine(newest, candidate)], dropped)) <=
				AGENCY_LAYER_MAX_TOKENS,
		);
		kept = [utteranceLine(newest, text)];
	}

	return {
		source: "agency.recent",
		authority: "host_record",
		freshness: "this_turn",
		body: {
			kind: "lines",
			header: AGENCY_FRAME,
			sections: build(kept, dropped),
		},
	};
}
