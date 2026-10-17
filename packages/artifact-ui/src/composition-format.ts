import type { CompositionValue, valueFormats } from "./composition-contracts";

export type CompositionFormat = {
	format?: (typeof valueFormats)[number] | undefined;
	decimals?: number | undefined;
	unit?: string | undefined;
};

/** Shown for every value that cannot be displayed (null, NaN, a series where a number is due). */
export const emptyValue = "—";

function groupedNumber(
	value: number,
	minimumDigits: number,
	maximumDigits: number,
): string {
	const text = new Intl.NumberFormat("ja-JP", {
		minimumFractionDigits: minimumDigits,
		maximumFractionDigits: maximumDigits,
		useGrouping: true,
	}).format(value);
	// A value that rounds to zero is shown as "0", never "-0".
	return /^-[0.,]*$/.test(text) ? text.slice(1) : text;
}

/** `decimals` fixes the digits; without it numbers and percents keep up to 2, yen and integers none. */
function formatNumber(value: number, options: CompositionFormat): string {
	const { format, decimals } = options;
	if (format === "integer") return groupedNumber(value, 0, 0);
	const fixed = decimals ?? undefined;
	const fallback = format === "yen" ? 0 : 2;
	const text = groupedNumber(value, fixed ?? 0, fixed ?? fallback);
	if (format === "percent") return `${text}%`;
	if (format !== "yen") return text;
	return text.startsWith("-") ? `-¥${text.slice(1)}` : `¥${text}`;
}

/** Formats a model value for display (ja-JP); "—" when it cannot be shown. */
export function formatCompositionValue(
	value: CompositionValue | undefined,
	options: CompositionFormat = {},
): string {
	const numeric = options.format !== undefined && options.format !== "text";
	let text: string;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return emptyValue;
		text = formatNumber(value, options);
	} else if (typeof value === "string" && !numeric) text = value;
	else if (typeof value === "boolean" && !numeric)
		text = value ? "はい" : "いいえ";
	else return emptyValue;
	const unit = options.unit;
	if (!unit) return text;
	return /^[A-Za-z]/.test(unit) ? `${text} ${unit}` : `${text}${unit}`;
}
