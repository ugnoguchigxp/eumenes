import { useId } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { cn } from "@/utils/cn";
import {
	type ChartKind,
	type ChartSeries,
	defaultFormatValue,
	lineDashes,
	MAX_CHART_SERIES,
	seriesColors,
	seriesKey,
	sliceColors,
	summarize,
	toRows,
} from "./chart-data";

export type { ChartKind, ChartPoint, ChartSeries } from "./chart-data";

export interface ChartProps {
	kind: ChartKind;
	title?: string;
	/** One to three series; a pie shows the first one. */
	series: ChartSeries[];
	xLabel?: string;
	yLabel?: string;
	note?: string;
	/** Formats values on the axis, in the tooltip and in the screen reader summary. */
	formatValue?: (value: number) => string;
	className?: string;
}

const CHART_HEIGHT = 280;

const tickStyle = { fill: "var(--muted-foreground)", fontSize: 12 };
const axisLine = { stroke: "var(--border)" };
const tooltipStyle = {
	background: "var(--popover)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius)",
	color: "var(--popover-foreground)",
	fontSize: 12,
};
const legendStyle = { fontSize: 12, color: "var(--foreground)" };

/**
 * Bar, line, area and pie charts of one to three series. Colors come from theme tokens,
 * the first series uses the accent.
 */
export const Chart = ({
	kind,
	title,
	series,
	xLabel,
	yLabel,
	note,
	formatValue = defaultFormatValue,
	className,
}: ChartProps) => {
	const summaryId = useId();
	const shown = series.slice(0, MAX_CHART_SERIES);
	const plotted =
		kind === "pie"
			? shown.slice(0, 1).map((s) => ({
					...s,
					points: s.points.filter((p) => p.y > 0),
				}))
			: shown;
	const hasData = plotted.some((s) => s.points.length > 0);
	const emptyNames = shown.filter((s) => s.points.length === 0).map((s) => s.name);
	const summary = summarize(kind, plotted, formatValue);
	const label = title ?? "グラフ";
	const rows = toRows(plotted);
	const fmt = (value: unknown) =>
		typeof value === "number" ? formatValue(value) : String(value ?? "");

	const tooltip = (
		<Tooltip
			contentStyle={tooltipStyle}
			labelStyle={{ color: "var(--popover-foreground)" }}
			itemStyle={{ color: "var(--popover-foreground)" }}
			formatter={(value) => fmt(value)}
		/>
	);
	const legend = <Legend wrapperStyle={legendStyle} />;
	const axes = (
		<>
			<CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
			<XAxis
				dataKey="x"
				tick={tickStyle}
				axisLine={axisLine}
				tickLine={axisLine}
				label={
					xLabel
						? { value: xLabel, position: "insideBottom", offset: -4, fill: "var(--muted-foreground)", fontSize: 12 }
						: undefined
				}
				height={xLabel ? 48 : 30}
			/>
			<YAxis
				tick={tickStyle}
				axisLine={axisLine}
				tickLine={axisLine}
				tickFormatter={fmt}
				width={yLabel ? 72 : 60}
				label={
					yLabel
						? { value: yLabel, angle: -90, position: "insideLeft", fill: "var(--muted-foreground)", fontSize: 12, style: { textAnchor: "middle" } }
						: undefined
				}
			/>
			{tooltip}
			{legend}
		</>
	);

	const renderChart = () => {
		const common = {
			accessibilityLayer: true,
			title: label,
			desc: summary,
			"aria-label": label,
			"aria-describedby": summaryId,
		} as const;
		if (kind === "pie") {
			const first = plotted[0];
			const data = (first?.points ?? []).map((p) => ({ name: String(p.x), value: p.y }));
			return (
				<PieChart {...common}>
					<Pie
						data={data}
						dataKey="value"
						nameKey="name"
						outerRadius="80%"
						stroke="var(--card)"
						isAnimationActive={false}
					>
						{data.map((d, i) => (
							<Cell key={`${i}-${d.name}`} fill={sliceColors[i % sliceColors.length]} />
						))}
					</Pie>
					{tooltip}
					{legend}
				</PieChart>
			);
		}
		if (kind === "bar")
			return (
				<BarChart data={rows} {...common}>
					{axes}
					{plotted.map((s, i) => (
						<Bar
							key={seriesKey(i)}
							dataKey={seriesKey(i)}
							name={s.name}
							fill={seriesColors[i]}
							radius={[3, 3, 0, 0]}
							isAnimationActive={false}
						/>
					))}
				</BarChart>
			);
		if (kind === "line")
			return (
				<LineChart data={rows} {...common}>
					{axes}
					{plotted.map((s, i) => (
						<Line
							key={seriesKey(i)}
							dataKey={seriesKey(i)}
							name={s.name}
							type="monotone"
							stroke={seriesColors[i]}
							strokeWidth={2}
							strokeDasharray={lineDashes[i]}
							dot={{ r: 3 }}
							connectNulls
							isAnimationActive={false}
						/>
					))}
				</LineChart>
			);
		return (
			<AreaChart data={rows} {...common}>
				{axes}
				{plotted.map((s, i) => (
					<Area
						key={seriesKey(i)}
						dataKey={seriesKey(i)}
						name={s.name}
						type="monotone"
						stroke={seriesColors[i]}
						fill={seriesColors[i]}
						fillOpacity={0.22}
						strokeWidth={2}
						strokeDasharray={lineDashes[i]}
						connectNulls
						isAnimationActive={false}
					/>
				))}
			</AreaChart>
		);
	};

	return (
		<figure
			className={cn(
				"m-0 flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-foreground",
				className,
			)}
		>
			{title && (
				<figcaption className="text-ui font-semibold text-foreground">{title}</figcaption>
			)}
			<p id={summaryId} className="sr-only">
				{summary}
			</p>
			{hasData ? (
				<div style={{ height: CHART_HEIGHT }} className="w-full min-w-0">
					<ResponsiveContainer width="100%" height="100%">
						{renderChart()}
					</ResponsiveContainer>
				</div>
			) : (
				<p role="status" className="py-8 text-center text-ui text-muted-foreground">
					データがありません
				</p>
			)}
			{hasData && emptyNames.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{emptyNames.map((name) => `${name}: データがありません`).join(" / ")}
				</p>
			)}
			{note && <p className="text-xs text-muted-foreground">{note}</p>}
		</figure>
	);
};
