import { afterAll, expect, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import type {
	CompositionModel,
	CompositionModelDefinition,
} from "./composition-contracts";
import {
	CompositionModelProvider,
	useCompositionModel,
} from "./composition-model";
import type { ArtifactRequest } from "./contracts";

// The parts need a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DiagramView, StepperView } =
	await import("./composition-diagram-components");

const definition: CompositionModelDefinition = {
	state: {
		step: { type: "number", initial: 0, min: 0, max: 2 },
		len: { type: "number", initial: 20, min: 0, max: 40 },
		other: { type: "number", initial: 1, min: 0, max: 5 },
	},
	computed: { twice: "len * 2" },
};

const diagram = {
	view: "diagram",
	source: { type: "none" },
	title: "力の図",
	stepBind: "step",
	elements: [
		{ type: "label", x: 10, y: 5, text: "常に表示" },
		{ type: "label", x: 10, y: 10, text: "最初だけ", steps: [0] },
		{
			type: "arrow",
			x1: 10,
			y1: 30,
			x2: "10 + len",
			y2: 30,
			label: "揚力",
			steps: [1, 2],
			highlightAt: [2],
		},
		{ type: "label", x: 10, y: 40, expr: 'format(twice, "number") + " m"' },
		{ type: "arrow", x1: 0, y1: 0, x2: "unknown + 1", y2: 0, steps: [0, 1, 2] },
	],
} as unknown as ArtifactRequest;

const stepper = (bind?: string) =>
	({
		view: "stepper",
		source: { type: "none" },
		title: "手順",
		...(bind ? { bind } : {}),
		steps: [
			{ title: "一段目", body: "最初" },
			{ title: "二段目", body: "次" },
			{ title: "三段目", body: "最後" },
		],
	}) as unknown as ArtifactRequest;

async function mount(
	model: CompositionModelDefinition | undefined,
	requests: ArtifactRequest[],
) {
	const seen: { model: CompositionModel | null } = { model: null };
	function Probe() {
		const model = useCompositionModel();
		useEffect(() => {
			seen.model = model;
		});
		return null;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<CompositionModelProvider model={model}>
				<Probe />
				{requests.map((request, index) =>
					request.view === "diagram" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed test list
						<DiagramView key={index} request={request} />
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed test list
						<StepperView key={index} request={request} />
					),
				)}
			</CompositionModelProvider>,
		);
	});
	return {
		container,
		seen,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

const shown = (container: HTMLElement) =>
	[...container.querySelectorAll("[data-diagram-element]")].map(
		(el) => `${el.getAttribute("data-diagram-element")}:${el.textContent}`,
	);
const click = (button: Element | null | undefined) =>
	act(async () => {
		(button as HTMLElement).click();
	});
const button = (container: HTMLElement, name: string) =>
	[...container.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === name,
	);

test("the stepper moves the shared step and the diagram shows its elements", async () => {
	const view = await mount(definition, [diagram, stepper("step")]);
	const { container } = view;
	// Step 0: the elements limited to later steps are hidden; the broken expression is skipped.
	expect(shown(container)).toEqual([
		"label:常に表示",
		"label:最初だけ",
		"label:40 m",
	]);
	expect(view.seen.model?.value("step")).toBe(0);

	await click(button(container, "次へ"));
	expect(view.seen.model?.value("step")).toBe(1);
	expect(shown(container)).toEqual([
		"label:常に表示",
		"arrow:揚力",
		"label:40 m",
	]);
	const arrows = () => container.querySelectorAll("svg line");
	expect(arrows()[0]?.getAttribute("stroke-width")).toBe("0.5");

	await click(button(container, "次へ"));
	expect(arrows()[0]?.getAttribute("stroke-width")).toBe("1");
	expect(button(container, "次へ")?.hasAttribute("disabled")).toBe(true);

	// Back to the front, the diagram follows again.
	await click(button(container, "前へ"));
	await click(button(container, "前へ"));
	expect(shown(container)).toContain("label:最初だけ");
	await view.unmount();
});

test("a state set from outside moves the expression coordinates", async () => {
	const view = await mount(definition, [diagram]);
	const arrow = () => view.container.querySelector("svg line");
	await act(async () => view.seen.model?.set("step", 1));
	expect(arrow()?.getAttribute("x2")).toBe("30");
	await act(async () => view.seen.model?.set("len", 35));
	expect(arrow()?.getAttribute("x2")).toBe("45");
	expect(shown(view.container)).toContain("label:70 m");
	await view.unmount();
});

test("without stepBind every element is shown and highlightAt is ignored", async () => {
	const free = {
		...diagram,
		stepBind: undefined,
	} as unknown as ArtifactRequest;
	const view = await mount(definition, [free]);
	expect(shown(view.container)).toEqual([
		"label:常に表示",
		"label:最初だけ",
		"arrow:揚力",
		"label:40 m",
	]);
	expect(
		view.container.querySelector("svg line")?.getAttribute("stroke-width"),
	).toBe("0.5");
	await view.unmount();
});

test("a stepper without bind keeps its own step", async () => {
	const view = await mount(definition, [stepper(), diagram]);
	await click(button(view.container, "次へ"));
	expect(view.container.textContent).toContain("二段目");
	expect(view.seen.model?.value("step")).toBe(0);
	await view.unmount();
});

test("a stepper bound to an unknown state keeps its own step instead of freezing", async () => {
	const view = await mount(definition, [stepper("ghost")]);
	await click(button(view.container, "次へ"));
	expect(view.container.textContent).toContain("二段目");
	await view.unmount();
});

test("both parts render without a model", async () => {
	const view = await mount(undefined, [diagram, stepper("step")]);
	expect(view.seen.model).toBeNull();
	// Number literals still draw; expressions cannot be worked out and the label shows "—".
	expect(shown(view.container)).toEqual([
		"label:常に表示",
		"label:最初だけ",
		"label:—",
	]);
	await click(button(view.container, "次へ"));
	expect(view.container.textContent).toContain("二段目");
	await view.unmount();
});

test("other parts render nothing", async () => {
	const other = {
		view: "text-block",
		title: "x",
	} as unknown as ArtifactRequest;
	const view = await mount(definition, [other]);
	expect(view.container.innerHTML).toBe("");
	await view.unmount();
});
