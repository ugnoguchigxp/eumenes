import type { Meta, StoryObj } from "@storybook/react-vite";
import { Chart, type ChartSeries } from "./Chart";

const meta = {
	title: "Components/Chart",
	component: Chart,
	parameters: { layout: "padded" },
	tags: ["autodocs"],
} satisfies Meta<typeof Chart>;

export default meta;
type Story = StoryObj<typeof meta>;

const months = ["1月", "2月", "3月", "4月", "5月", "6月"];
const make = (name: string, values: number[]): ChartSeries => ({
	name,
	points: values.map((y, i) => ({ x: months[i] ?? String(i), y })),
});
const sales = make("売上", [120, 150, 90, 180, 210, 190]);
const cost = make("費用", [80, 95, 70, 110, 130, 120]);
const profit = make("利益", [40, 55, 20, 70, 80, 70]);
const yen = (n: number) => `${n.toLocaleString("ja-JP")}万円`;

export const Bar: Story = {
	args: {
		kind: "bar",
		title: "月別売上",
		series: [sales],
		xLabel: "月",
		yLabel: "万円",
		formatValue: yen,
	},
};

export const Line: Story = {
	args: {
		kind: "line",
		title: "売上と費用",
		series: [sales, cost],
		formatValue: yen,
	},
};

export const Area: Story = {
	args: {
		kind: "area",
		title: "売上・費用・利益",
		series: [sales, cost, profit],
		note: "出典: 社内集計",
		formatValue: yen,
	},
};

export const Pie: Story = {
	args: {
		kind: "pie",
		title: "費用の内訳",
		series: [
			{
				name: "費用",
				points: [
					{ x: "人件費", y: 52 },
					{ x: "広告費", y: 21 },
					{ x: "家賃", y: 14 },
					{ x: "その他", y: 13 },
				],
			},
		],
		formatValue: (n) => `${n}%`,
	},
};

export const BarMultiSeries: Story = {
	args: { kind: "bar", title: "売上と費用", series: [sales, cost, profit] },
};

export const Empty: Story = {
	args: {
		kind: "line",
		title: "データなし",
		series: [{ name: "売上", points: [] }],
	},
};

export const Dark: Story = {
	args: {
		kind: "line",
		title: "売上と費用",
		series: [sales, cost, profit],
		formatValue: yen,
	},
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: "1.5rem",
			}}
		>
			<Chart {...args} />
		</div>
	),
};

export const DarkPie: Story = {
	args: Pie.args,
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: "1.5rem",
			}}
		>
			<Chart {...args} />
		</div>
	),
};
