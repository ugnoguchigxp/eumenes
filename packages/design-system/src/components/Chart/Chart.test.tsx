import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chart, type ChartSeries } from "./Chart";
import { toRows } from "./chart-data";

const sales: ChartSeries = {
	name: "売上",
	points: [
		{ x: "1月", y: 120 },
		{ x: "2月", y: 150 },
		{ x: "3月", y: 90 },
	],
};
const cost: ChartSeries = {
	name: "費用",
	points: [
		{ x: "1月", y: 80 },
		{ x: "2月", y: 95 },
		{ x: "3月", y: 70 },
	],
};

describe("Chart", () => {
	// jsdom has no layout; ResponsiveContainer reads its size from getBoundingClientRect.
	beforeEach(() => {
		const real = HTMLElement.prototype.getBoundingClientRect;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				if (!this.classList.contains("recharts-responsive-container"))
					return real.call(this);
				return {
					width: 480,
					height: 280,
					top: 0,
					left: 0,
					right: 480,
					bottom: 280,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			},
		);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([
		["bar", ".recharts-bar-rectangle"],
		["line", ".recharts-line-curve"],
		["area", ".recharts-area-area"],
		["pie", ".recharts-pie-sector"],
	] as const)("%s を描画する", (kind, selector) => {
		const { container } = render(<Chart kind={kind} title="月別" series={[sales]} />);
		expect(container.querySelectorAll(selector).length).toBeGreaterThan(0);
		expect(container.querySelector("figcaption")).toHaveTextContent("月別");
	});

	it("凡例に系列名を出し、複数系列を描画する", () => {
		const { container } = render(<Chart kind="line" series={[sales, cost]} />);
		const legend = container.querySelector(".recharts-legend-wrapper");
		expect(legend).toHaveTextContent("売上");
		expect(legend).toHaveTextContent("費用");
		expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
	});

	it("第1系列にアクセント色を使う", () => {
		const { container } = render(<Chart kind="bar" series={[sales, cost]} />);
		const fills = [...container.querySelectorAll(".recharts-bar")].map((el) =>
			el.querySelector("path")?.getAttribute("fill"),
		);
		expect(fills[0]).toBe("var(--ds-accent, var(--primary))");
		expect(fills[1]).not.toBe(fills[0]);
	});

	it("SVG に aria-label を持ち、要約を読み上げ用に持つ", () => {
		const { container } = render(<Chart kind="bar" title="月別売上" series={[sales]} />);
		expect(container.querySelector(".recharts-wrapper > svg")).toHaveAttribute(
			"aria-label",
			"月別売上",
		);
		expect(container.querySelector(".sr-only")).toHaveTextContent(
			"棒グラフ。売上: 3点、最小 90、最大 150",
		);
	});

	it("formatValue を軸と要約に使う", () => {
		const { container } = render(
			<Chart kind="bar" series={[sales]} formatValue={(n) => `${n}円`} />,
		);
		expect(container.querySelector(".sr-only")).toHaveTextContent("最大 150円");
		expect(container.querySelector(".recharts-yAxis-tick-labels")).toHaveTextContent("円");
	});

	it("軸ラベルと注記を出す", () => {
		render(<Chart kind="bar" series={[sales]} xLabel="月" yLabel="万円" note="出典: 社内集計" />);
		expect(screen.getByText("月")).toBeInTheDocument();
		expect(screen.getByText("万円")).toBeInTheDocument();
		expect(screen.getByText("出典: 社内集計")).toBeInTheDocument();
	});

	it("点が無いときは「データがありません」を出す", () => {
		const { container } = render(
			<Chart kind="line" series={[{ name: "空", points: [] }]} />,
		);
		expect(screen.getByText("データがありません")).toBeInTheDocument();
		expect(container.querySelector("svg")).toBeNull();
	});

	it("点の無い系列だけを「データがありません」と示す", () => {
		render(<Chart kind="line" series={[sales, { name: "空", points: [] }]} />);
		expect(screen.getByText("空: データがありません")).toBeInTheDocument();
	});

	it("円グラフは0以下の値を描かない", () => {
		const { container } = render(
			<Chart
				kind="pie"
				series={[
					{
						name: "内訳",
						points: [
							{ x: "A", y: 3 },
							{ x: "B", y: 0 },
							{ x: "C", y: 1 },
						],
					},
				]}
			/>,
		);
		expect(container.querySelectorAll(".recharts-pie-sector")).toHaveLength(2);
	});

	it("同じ x の点を系列の中で上書きしない", () => {
		const { container } = render(
			<Chart
				kind="bar"
				series={[
					{
						name: "重複",
						points: [
							{ x: "A", y: 1 },
							{ x: "A", y: 2 },
							{ x: "B", y: 3 },
						],
					},
				]}
			/>,
		);
		expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(3);
		expect(container.querySelector(".sr-only")).toHaveTextContent("3点");
	});

	it("系列をまたいだ同じ x は同じ行に並ぶ", () => {
		expect(toRows([sales, cost])).toHaveLength(3);
		expect(toRows([{ name: "a", points: [{ x: 1, y: 1 }, { x: 1, y: 2 }] }, { name: "b", points: [{ x: 1, y: 9 }] }])).toEqual([
			{ x: 1, s0: 1, s1: 9 },
			{ x: 1, s0: 2 },
		]);
	});

	it("円グラフの同名スライスでも key が重ならない", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { container } = render(
			<Chart
				kind="pie"
				series={[
					{
						name: "内訳",
						points: [
							{ x: "A", y: 1 },
							{ x: "A", y: 2 },
						],
					},
				]}
			/>,
		);
		expect(container.querySelectorAll(".recharts-pie-sector")).toHaveLength(2);
		expect(error).not.toHaveBeenCalledWith(
			expect.stringContaining("same key"),
			expect.anything(),
			expect.anything(),
		);
		error.mockRestore();
	});
});
