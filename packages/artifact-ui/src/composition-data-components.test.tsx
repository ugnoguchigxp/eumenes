import { afterAll, expect, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import { Fragment, type ReactNode } from "react";
import type { CompositionModelDefinition } from "./composition-contracts";
import type { ArtifactRequest } from "./contracts";

// The views need a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
	// recharts observes the size of its container.
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
// jsdom has no layout: give recharts' container a size (its legend and ticks measure as 0).
const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function (
	this: HTMLElement,
) {
	return this.classList.contains("recharts-responsive-container")
		? ({
				width: 480,
				height: 280,
				top: 0,
				left: 0,
				right: 480,
				bottom: 280,
				x: 0,
				y: 0,
			} as DOMRect)
		: rect.call(this);
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CompositionModelProvider } = await import("./composition-model");
const { CalculatorView, ChartView, DataTableView, FormulaView } =
	await import("./composition-data-components");

const definition: CompositionModelDefinition = {
	state: { n: { type: "number", initial: 1, min: 0, max: 1000 } },
	computed: {
		squares: { series: { from: 1, to: 5, expr: "i * i" } },
		long: { series: { from: 1, to: 250, expr: "i" } },
		double: "n * 2",
	},
};

async function mount(
	model: CompositionModelDefinition | undefined,
	...views: ReactNode[]
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<CompositionModelProvider model={model}>
				{views.map((child, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of views
					<Fragment key={index}>{child}</Fragment>
				))}
			</CompositionModelProvider>,
		);
	});
	return {
		container,
		unmount: () => act(async () => root.unmount()),
	};
}
const press = (container: HTMLElement, name: string) =>
	act(async () => {
		const button = [...container.querySelectorAll("button")].find(
			(b) => b.textContent === name,
		);
		if (!button) throw new Error(`no button ${name}`);
		button.click();
	});
const text = (container: HTMLElement, selector: string) =>
	container.querySelector(selector)?.textContent ?? "";

const req = (request: Record<string, unknown>) => request as ArtifactRequest;

test("a chart draws the series of the model and the static points", async () => {
	const view = await mount(
		definition,
		<ChartView
			request={req({
				view: "chart",
				kind: "line",
				title: "二乗",
				series: [
					{ name: "二乗", from: "squares" },
					{
						name: "基準",
						points: [
							{ x: 1, y: 3 },
							{ x: 5, y: 3 },
						],
					},
				],
				unit: "点",
			})}
		/>,
	);
	const legend = text(view.container, ".recharts-legend-wrapper");
	expect(legend).toContain("二乗");
	expect(legend).toContain("基準");
	expect(view.container.querySelectorAll(".recharts-line-curve")).toHaveLength(
		2,
	);
	expect(text(view.container, ".sr-only")).toContain("最大 25点");
	await view.unmount();
});

test("a chart of an unknown or non-series name has no data", async () => {
	const view = await mount(
		definition,
		<ChartView
			request={req({
				view: "chart",
				kind: "bar",
				series: [{ name: "なし", from: "double" }],
			})}
		/>,
	);
	expect(view.container.textContent).toContain("データがありません");
	await view.unmount();
});

test("a data-table evaluates each column per point of a series", async () => {
	const view = await mount(
		definition,
		<DataTableView
			request={req({
				view: "data-table",
				title: "二乗表",
				series: "squares",
				columns: [
					{ header: "x", expr: "x" },
					{ header: "金額", expr: "y * 1000", format: "yen" },
				],
			})}
		/>,
	);
	const rows = [...view.container.querySelectorAll("tbody tr")].map((row) =>
		[...row.querySelectorAll("td")].map((cell) => cell.textContent),
	);
	expect(rows).toHaveLength(5);
	expect(rows[1]).toEqual(["2", "¥4,000"]);
	expect(view.container.querySelector("td")?.className).toContain("text-right");
	await view.unmount();
});

test("a data-table shows 200 rows of a series and reports the rest", async () => {
	const view = await mount(
		definition,
		<DataTableView
			request={req({
				view: "data-table",
				series: "long",
				columns: [{ header: "x", expr: "x" }],
			})}
		/>,
	);
	expect(view.container.querySelectorAll("tbody tr")).toHaveLength(200);
	expect(view.container.textContent).toContain("他50行");
	await view.unmount();
});

test("a data-table shows static rows, formatted by column", async () => {
	const view = await mount(
		undefined,
		<DataTableView
			request={req({
				view: "data-table",
				columns: [{ header: "品名" }, { header: "価格", format: "yen" }],
				rows: [
					["りんご", 120],
					["みかん", 80.5],
				],
			})}
		/>,
	);
	expect(text(view.container, "tbody")).toContain("¥120");
	expect(text(view.container, "tbody")).toContain("りんご");
	await view.unmount();
});

test("a data-table of a series without a model is empty", async () => {
	const view = await mount(
		undefined,
		<DataTableView
			request={req({
				view: "data-table",
				series: "squares",
				columns: [{ header: "x", expr: "x" }],
			})}
		/>,
	);
	expect(view.container.textContent).toContain("データがありません");
	await view.unmount();
});

test("a formula shows its value after the typeset formula", async () => {
	const view = await mount(
		definition,
		<FormulaView
			request={req({
				view: "formula",
				label: "ステップ1",
				tex: "n \\times 2",
				expr: "double",
				unit: "km",
			})}
		/>,
	);
	expect(view.container.querySelector(".katex")).not.toBeNull();
	expect(view.container.textContent).toContain("ステップ1");
	expect(view.container.textContent).toContain("= 2 km");
	await view.unmount();
});

test("a formula whose expression has no value shows the empty mark", async () => {
	const view = await mount(
		definition,
		<FormulaView request={req({ view: "formula", tex: "x", expr: "ghost" })} />,
	);
	expect(view.container.textContent).toContain("= —");
	await view.unmount();
});

test("the calculator's result goes to resultBind and the formula follows", async () => {
	const view = await mount(
		definition,
		<CalculatorView
			request={req({
				view: "calculator",
				label: "電卓",
				preset: "2 + 3",
				mode: "scientific",
				resultBind: "n",
			})}
		/>,
		<FormulaView
			request={req({ view: "formula", tex: "n \\times 2", expr: "double" })}
		/>,
	);
	expect(view.container.textContent).toContain("= 2");
	expect(text(view.container, "[role=group] [role=status]")).toBe("2 + 3");
	await press(view.container, "=");
	expect(text(view.container, "[role=group] [role=status]")).toBe("5");
	expect(view.container.textContent).toContain("= 10");
	await view.unmount();
});

test("the calculator evaluates with the host expression language", async () => {
	const view = await mount(
		definition,
		<CalculatorView
			request={req({
				view: "calculator",
				mode: "scientific",
				preset: "1000 * tan(89.5)",
			})}
		/>,
	);
	await press(view.container, "=");
	expect(text(view.container, "[role=group] [role=status]")).toStartWith(
		"114588.6",
	);
	await view.unmount();
});

test("the calculator shows an error for what the language cannot work out", async () => {
	const view = await mount(
		definition,
		<CalculatorView request={req({ view: "calculator", preset: "1 / 0" })} />,
	);
	await press(view.container, "=");
	expect(text(view.container, "[role=group] [role=status]")).toBe("エラー");
	await view.unmount();
});

test("without a model the views draw and the calculator works", async () => {
	const view = await mount(
		undefined,
		<ChartView
			request={req({
				view: "chart",
				kind: "bar",
				series: [
					{
						name: "a",
						points: [
							{ x: "A", y: 1 },
							{ x: "B", y: 2 },
						],
					},
				],
			})}
		/>,
		<FormulaView
			request={req({ view: "formula", tex: "2 \\times 3", expr: "2 * 3" })}
		/>,
		<CalculatorView
			request={req({ view: "calculator", preset: "6 * 7", resultBind: "n" })}
		/>,
	);
	expect(
		view.container.querySelectorAll(".recharts-bar-rectangle").length,
	).toBeGreaterThan(0);
	expect(view.container.textContent).toContain("= 6");
	await press(view.container, "=");
	expect(text(view.container, "[role=group] [role=status]")).toBe("42");
	await view.unmount();
});

test("the calculator accepts pi after a number through the host language", async () => {
	const view = await mount(
		definition,
		<CalculatorView
			request={req({ view: "calculator", mode: "scientific" })}
		/>,
	);
	for (const name of ["2", "π", "="]) await press(view.container, name);
	expect(text(view.container, "[role=group] [role=status]")).toStartWith(
		"6.28318530718",
	);
	await view.unmount();
});

test("float noise is trimmed from the result and from resultBind", async () => {
	const view = await mount(
		definition,
		<CalculatorView
			request={req({
				view: "calculator",
				preset: "0.1 + 0.2",
				resultBind: "n",
			})}
		/>,
		<FormulaView request={req({ view: "formula", tex: "n", expr: "n" })} />,
	);
	await press(view.container, "=");
	expect(text(view.container, "[role=group] [role=status]")).toBe("0.3");
	expect(view.container.textContent).toContain("= 0.3");
	await view.unmount();
});

test("a changed preset or mode starts the calculator over", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = (preset: string, mode: "basic" | "scientific") =>
		act(async () => {
			root.render(
				<CompositionModelProvider model={definition}>
					<CalculatorView request={req({ view: "calculator", preset, mode })} />
				</CompositionModelProvider>,
			);
		});
	await render("1 + 1", "basic");
	expect(text(container, "[role=status]")).toBe("1 + 1");
	await render("2 * 3", "basic");
	expect(text(container, "[role=status]")).toBe("2 * 3");
	await render("2 * 3", "scientific");
	expect(container.querySelector("button[aria-label], button")).not.toBeNull();
	expect(
		[...container.querySelectorAll("button")].some(
			(b) => b.textContent === "sin",
		),
	).toBe(true);
	await act(async () => root.unmount());
});

test("a view of another kind renders nothing", async () => {
	const view = await mount(
		definition,
		<ChartView request={req({ view: "formula", tex: "x" })} />,
		<CalculatorView request={req({ view: "formula", tex: "x" })} />,
	);
	expect(view.container.innerHTML).toBe("");
	await view.unmount();
});
