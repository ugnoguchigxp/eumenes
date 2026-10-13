import type { Remember } from "../contracts";

type DatePart = NonNullable<NonNullable<Remember["validity"]>["from"]>;
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026", "2026-09" or "2026-09-01" as the library's precision-carrying date; null for any other text. */
export function parseDatePart(text: string): DatePart | null {
	const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
	if (!match) return null;
	const year = Number(match[1]);
	if (match[2] === undefined) return { precision: "year", year };
	const month = Number(match[2]);
	if (match[3] === undefined) return { precision: "month", year, month };
	return { precision: "day", year, month, day: Number(match[3]) };
}
export function formatDatePart(date: DatePart): string {
	if (date.precision === "year") return String(date.year).padStart(4, "0");
	if (date.precision === "month")
		return `${String(date.year).padStart(4, "0")}-${pad(date.month ?? 1)}`;
	return `${String(date.year).padStart(4, "0")}-${pad(date.month ?? 1)}-${pad(date.day ?? 1)}`;
}
/** The host's local calendar day of an instant, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/**
 * The period of an item as the screen and the agent read it. The precise calendar period wins;
 * millisecond bounds are shown as local days (an exclusive end is the day before).
 */
export function validityOf(item: {
	validity?: { from?: DatePart; until?: DatePart } | undefined;
	validFromMs: number | null;
	validUntilMs: number | null;
}): { from?: string; until?: string } | null {
	const from = item.validity?.from
		? formatDatePart(item.validity.from)
		: item.validFromMs === null
			? undefined
			: localDay(item.validFromMs);
	const until = item.validity?.until
		? formatDatePart(item.validity.until)
		: item.validUntilMs === null
			? undefined
			: localDay(item.validUntilMs - 1);
	if (from === undefined && until === undefined) return null;
	return {
		...(from === undefined ? {} : { from }),
		...(until === undefined ? {} : { until }),
	};
}
