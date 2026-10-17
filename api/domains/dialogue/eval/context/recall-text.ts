/**
 * The recalled-exchanges text, seeded directly. Production writes it in the memory domain from the embedding
 * search (`recallTurns`); the offline harness has no embeddings, so a case's `recall` entries are rendered into the
 * same text by memory's renderer (`renderRecallBlock`) and published as the window's prefetch. The entry time is
 * fixed to Asia/Tokyo so the bytes do not depend on the machine's time zone.
 */
import {
	RECALL_BLOCK_OPEN,
	type RecalledEntry,
	parseRecallBlock,
} from "../../../memory";

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:mm` in Asia/Tokyo, the form memory shows a recalled exchange's time in. */
export function recallMinute(iso: string): string {
	const date = new Date(Date.parse(iso) + 9 * 3_600_000);
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** The frame sentence and the entries of a prefetch text, or null when the text is not in the recall form. */
export function splitRecallText(
	text: string,
): { frame: string; entries: RecalledEntry[] } | null {
	const entries = parseRecallBlock(text);
	return entries
		? {
				frame: text.slice(0, text.indexOf(RECALL_BLOCK_OPEN)).trimEnd(),
				entries,
			}
		: null;
}
