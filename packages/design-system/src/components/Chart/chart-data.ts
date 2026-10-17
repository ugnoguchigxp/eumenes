export type ChartKind = "bar" | "line" | "area" | "pie";

export interface ChartPoint {
	x: number | string;
	y: number;
}

export interface ChartSeries {
	name: string;
	points: ChartPoint[];
}

export const MAX_CHART_SERIES = 3;

/** Series colors: the accent first, then theme tokens that stay readable in every theme. */
export const seriesColors = [
	"var(--ds-accent, var(--primary))",
	"var(--warning)",
	"var(--success)",
] as const;

/** Slice colors of a pie: the series colors, then mixes so neighbours stay apart. */
export const sliceColors = [
	...seriesColors,
	"var(--destructive)",
	"color-mix(in srgb, var(--ds-accent, var(--primary)) 55%, var(--foreground))",
	"color-mix(in srgb, var(--warning) 55%, var(--foreground))",
	"color-mix(in srgb, var(--success) 55%, var(--foreground))",
	"color-mix(in srgb, var(--destructive) 55%, var(--foreground))",
] as const;

export const lineDashes = [undefined, "6 3", "2 3"] as const;

export type ChartRow = { x: number | string } & Record<
	string,
	number | string | undefined
>;

export const seriesKey = (index: number) => `s${index}`;

/**
 * Merges the series into one row per x, keeping the order of first appearance. The n-th point
 * of a series with the same x joins the n-th row of that x, so repeated x values stay apart.
 */
export const toRows = (series: ChartSeries[]): ChartRow[] => {
	const rows = new Map<string, ChartRow>();
	series.forEach((s, index) => {
		const seen = new Map<string, number>();
		for (const point of s.points) {
			const id = String(point.x);
			const count = seen.get(id) ?? 0;
			seen.set(id, count + 1);
			const rowId = `${id}\u0000${count}`;
			const row: ChartRow = rows.get(rowId) ?? { x: point.x };
			row[seriesKey(index)] = point.y;
			rows.set(rowId, row);
		}
	});
	return [...rows.values()];
};

export const defaultFormatValue = (value: number): string =>
	value.toLocaleString("ja-JP", { maximumFractionDigits: 6 });

/** A text a screen reader can use in place of the picture. */
export const summarize = (
	kind: ChartKind,
	series: ChartSeries[],
	format: (value: number) => string,
): string => {
	const kindLabel = {
		bar: "棒グラフ",
		line: "折れ線グラフ",
		area: "面グラフ",
		pie: "円グラフ",
	}[kind];
	const parts = series.map((s) => {
		if (s.points.length === 0) return `${s.name}: データがありません`;
		if (kind === "pie")
			return `${s.name}: ${s.points.map((p) => `${p.x} ${format(p.y)}`).join("、")}`;
		const values = s.points.map((p) => p.y);
		const first = s.points[0];
		const last = s.points[s.points.length - 1];
		return `${s.name}: ${s.points.length}点、最小 ${format(Math.min(...values))}、最大 ${format(Math.max(...values))}、${first?.x} から ${last?.x} まで`;
	});
	return `${kindLabel}。${parts.join("。")}`;
};
