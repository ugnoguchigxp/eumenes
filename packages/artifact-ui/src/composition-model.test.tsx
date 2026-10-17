import { afterAll, expect, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import type {
	CompositionModel,
	CompositionModelDefinition,
} from "./composition-contracts";
import { computeValues, maxSeriesPoints } from "./composition-compute";
import {
	CompositionModelProvider,
	useCompositionModel,
} from "./composition-model";

// The Provider test needs a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const retirement: CompositionModelDefinition = {
	state: {
		age: { type: "number", initial: 40, min: 20, max: 70 },
		monthly: { type: "number", initial: 30000, min: 0, max: 500000 },
		rate: { type: "number", initial: 3, min: 0, max: 15 },
		plan: { type: "text", initial: "basic" },
		pro: { type: "boolean", initial: false },
	},
	computed: {
		balance: {
			series: {
				from: "age",
				to: 65,
				initial: 0,
				expr: "prev * (1 + rate / 100) + monthly * 12",
			},
		},
		atRetire: "last(balance)",
		years: "65 - age",
		label: 'plan + (pro ? "+" : "")',
	},
};
const initialStates = (definition: CompositionModelDefinition) =>
	new Map(
		Object.entries(definition.state ?? {}).map(([name, state]) => [
			name,
			state.initial,
		]),
	);
const compute = (definition: CompositionModelDefinition) =>
	computeValues(definition, initialStates(definition));

test("computed values follow the state in dependency order", () => {
	const values = compute({
		state: { a: { type: "number", initial: 2 } },
		// declared out of order on purpose
		computed: { c: "b * 10", b: "a + 1" },
	});
	expect(values.get("b")).toBe(3);
	expect(values.get("c")).toBe(30);
});

test("a series makes {x: i, y} points from the first to the last index", () => {
	const values = compute(retirement);
	const balance = values.get("balance") as Array<{ x: number; y: number }>;
	expect(balance).toHaveLength(26);
	expect(balance[0]).toEqual({ x: 40, y: 360000 });
	expect(balance[1]?.y).toBeCloseTo(360000 * 1.03 + 360000);
	expect(balance.at(-1)?.x).toBe(65);
	expect(values.get("atRetire")).toBe(balance.at(-1)?.y as number);
	expect(values.get("years")).toBe(25);
	expect(values.get("label")).toBe("basic");
});

test("series bounds are rounded and an empty range gives an empty series", () => {
	const values = compute({
		state: { n: { type: "number", initial: 2.6 } },
		computed: {
			up: { series: { from: 1, to: "n", expr: "i * 2" } },
			none: { series: { from: 5, to: 1, expr: "i" } },
		},
	});
	expect(values.get("up")).toEqual([
		{ x: 1, y: 2 },
		{ x: 2, y: 4 },
		{ x: 3, y: 6 },
	]);
	expect(values.get("none")).toEqual([]);
});

test("circular references, bad expressions and unknown names give null", () => {
	const values = compute({
		computed: {
			a: "b + 1",
			b: "a + 1",
			self: "self",
			broken: "1 +",
			unknown: "ghost * 2",
			downstream: "a + 1",
		},
	});
	for (const name of ["a", "b", "self", "broken", "unknown", "downstream"])
		expect(values.get(name)).toBeNull();
});

test("series limits: 1,200 points each and a shared step budget", () => {
	const full = compute({
		computed: { s: { series: { from: 1, to: maxSeriesPoints, expr: "i" } } },
	});
	expect(full.get("s")).toHaveLength(maxSeriesPoints);
	const tooLong = compute({
		computed: {
			s: { series: { from: 1, to: maxSeriesPoints + 1, expr: "i" } },
		},
	});
	expect(tooLong.get("s")).toBeNull();
	const many = (name: string) => [
		name,
		{ series: { from: 1, to: maxSeriesPoints, expr: "i" } },
	];
	const budgeted = compute({
		computed: Object.fromEntries(
			["a", "b", "c", "d", "e", "f", "g", "h", "j"].map(many),
		) as never,
	});
	// 8 series use 9,600 of the 10,000 steps; the ninth cannot finish.
	expect(budgeted.get("h")).toHaveLength(maxSeriesPoints);
	expect(budgeted.get("j")).toBeNull();
});

test("a series whose point fails is null as a whole", () => {
	const values = compute({
		computed: { s: { series: { from: 0, to: 3, expr: "10 / (2 - i)" } } },
	});
	expect(values.get("s")).toBeNull();
});

test("names of Object.prototype read as nothing", () => {
	const values = compute(
		JSON.parse(
			'{"state":{"constructor":{"type":"number","initial":1}},"computed":{"toString":"constructor + 1","valueOf":"hasOwnProperty"}}',
		),
	);
	expect(values.get("toString")).toBe(2);
	expect(values.get("valueOf")).toBeNull();
});

async function mount(definition: CompositionModelDefinition | undefined) {
	const seen: { model: CompositionModel | null } = { model: null };
	const remember = (model: CompositionModel | null) => {
		seen.model = model;
	};
	function Probe() {
		remember(useCompositionModel());
		return null;
	}
	const container = document.createElement("div");
	const root = createRoot(container);
	const render = (next: CompositionModelDefinition | undefined) =>
		act(async () => {
			root.render(
				<CompositionModelProvider model={next}>
					<Probe />
				</CompositionModelProvider>,
			);
		});
	await render(definition);
	return {
		seen,
		render,
		unmount: () => act(async () => root.unmount()),
	};
}

test("the Provider starts at the initial values and recomputes on set", async () => {
	const view = await mount(retirement);
	const model = () => view.seen.model!;
	expect(model().value("years")).toBe(25);
	await act(async () => model().set("age", 55));
	expect(model().value("years")).toBe(10);
	expect((model().value("balance") as unknown[]).length).toBe(11);
	await act(async () => model().set("plan", "premium"));
	await act(async () => model().set("pro", true));
	expect(model().value("label")).toBe("premium+");
	await view.unmount();
});

test("set rounds into min and max and ignores unknown names, computed values and wrong types", async () => {
	const view = await mount(retirement);
	const model = () => view.seen.model!;
	await act(async () => model().set("age", 99));
	expect(model().value("age")).toBe(70);
	await act(async () => model().set("age", -5));
	expect(model().value("age")).toBe(20);
	await act(async () => model().set("age", "30"));
	await act(async () => model().set("age", Number.NaN));
	expect(model().value("age")).toBe(20);
	await act(async () => model().set("years", 1));
	await act(async () => model().set("ghost", 1));
	await act(async () => model().set("constructor", 1));
	expect(model().value("years")).toBe(45);
	expect(model().value("ghost")).toBeNull();
	await act(async () => model().set("pro", "yes"));
	expect(model().value("pro")).toBe(false);
	await view.unmount();
});

test("an initial value outside min and max is rounded in too", async () => {
	const view = await mount({
		state: { n: { type: "number", initial: 500, max: 100 } },
	});
	expect(view.seen.model!.value("n")).toBe(100);
	await view.unmount();
});

test("evaluate uses the current values and the locals, and never throws", async () => {
	const view = await mount(retirement);
	const model = view.seen.model!;
	expect(model.evaluate("years * 2")).toBe(50);
	expect(model.evaluate("x + y", { x: 1, y: 2 })).toBe(3);
	expect(model.evaluate("years + x", { x: 5 })).toBe(30);
	expect(model.evaluate("1 +")).toBeNull();
	expect(model.evaluate("ghost")).toBeNull();
	expect(model.evaluate("1 / 0")).toBeNull();
	await view.unmount();
});

test("state returns the definition for input defaults", async () => {
	const view = await mount(retirement);
	expect(view.seen.model!.state("rate")).toEqual({
		type: "number",
		initial: 3,
		min: 0,
		max: 15,
	});
	expect(view.seen.model!.state("years")).toBeNull();
	expect(view.seen.model!.state("toString")).toBeNull();
	await view.unmount();
});

test("without a model the hook gives null", async () => {
	const view = await mount(undefined);
	expect(view.seen.model).toBeNull();
	await view.unmount();
});

test("a changed definition starts over from its initial values", async () => {
	const view = await mount(retirement);
	await act(async () => view.seen.model!.set("age", 60));
	expect(view.seen.model!.value("age")).toBe(60);
	await view.render({
		...retirement,
		state: { ...retirement.state!, age: { type: "number", initial: 30 } },
	});
	expect(view.seen.model!.value("age")).toBe(30);
	await view.unmount();
});
