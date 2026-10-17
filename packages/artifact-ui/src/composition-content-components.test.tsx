import { afterAll, afterEach, expect, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import type { CompositionModelDefinition } from "./composition-contracts";
import type { ArtifactRequest } from "./contracts";

// These views need a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
});
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	// Radix (Collapsible, Switch, Presence) reads these from the global scope.
	getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
	requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
	cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
	HTMLElement: dom.window.HTMLElement,
	HTMLFormElement: dom.window.HTMLFormElement,
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CompositionModelProvider } = await import("./composition-model");
const {
	ChoiceView,
	ComparisonTableView,
	FaqView,
	NumberInputView,
	PricingCardView,
	SliderView,
	StatView,
	TimelineView,
	ToggleView,
} = await import("./composition-content-components");

const req = (request: Record<string, unknown>) =>
	request as unknown as ArtifactRequest;

const definition: CompositionModelDefinition = {
	state: {
		age: { type: "number", initial: 40, min: 20, max: 70 },
		rate: { type: "number", initial: 3 },
		plan: { type: "text", initial: "" },
		pro: { type: "boolean", initial: false },
	},
	computed: { years: "65 - age", doubled: "rate * 2" },
};

let mounted: Array<{ root: ReturnType<typeof createRoot>; el: HTMLElement }> =
	[];
async function mount(node: ReactNode, model?: CompositionModelDefinition) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	mounted.push({ root, el });
	await act(async () => {
		root.render(
			<CompositionModelProvider model={model}>{node}</CompositionModelProvider>,
		);
	});
	return el;
}
afterEach(async () => {
	for (const { root, el } of mounted) {
		await act(async () => root.unmount());
		el.remove();
	}
	mounted = [];
});

const inputOf = (el: HTMLElement, selector: string) =>
	el.querySelector(selector) as HTMLInputElement;
async function type(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		dom.window.HTMLInputElement.prototype,
		"value",
	)?.set;
	await act(async () => {
		setter?.call(input, text);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
const click = (element: Element) =>
	act(async () => {
		element.dispatchEvent(
			new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
const blur = (element: Element) =>
	act(async () => {
		element.dispatchEvent(
			new dom.window.FocusEvent("focusout", { bubbles: true }),
		);
	});

const stat = (extra: Record<string, unknown> = {}) =>
	req({ view: "stat", label: "残り年数", expr: "years", ...extra });
const ageInput = (extra: Record<string, unknown> = {}) =>
	req({ view: "number-input", bind: "age", label: "年齢", ...extra });

test("typing in a number input recomputes the stat", async () => {
	const el = await mount(
		<>
			<NumberInputView request={ageInput({ unit: "歳" })} />
			<StatView request={stat({ format: "integer", unit: "年" })} />
		</>,
		definition,
	);
	expect(el.textContent).toContain("25年");
	expect(el.textContent).toContain("歳");
	await type(inputOf(el, "input[type=number]"), "55");
	expect(el.textContent).toContain("10年");
	expect(inputOf(el, "input[type=number]").value).toBe("55");
});

test("an empty or unparsable text writes nothing and blur shows the state again", async () => {
	const el = await mount(
		<>
			<NumberInputView request={ageInput()} />
			<StatView request={stat({ format: "integer" })} />
		</>,
		definition,
	);
	const input = inputOf(el, "input[type=number]");
	await type(input, "50");
	expect(el.textContent).toContain("15");
	await type(input, "");
	expect(input.value).toBe("");
	expect(el.textContent).toContain("15");
	await blur(input);
	expect(input.value).toBe("50");
});

test("a number input clamps to its own min and max, then to the state's", async () => {
	const el = await mount(
		<>
			<NumberInputView request={ageInput({ min: 30, max: 60 })} />
			<StatView request={stat({ format: "integer" })} />
		</>,
		definition,
	);
	const input = inputOf(el, "input[type=number]");
	expect(input.min).toBe("30");
	await type(input, "10");
	expect(el.textContent).toContain("35"); // age 30
	await type(input, "99");
	expect(el.textContent).toContain("5"); // age 60
	await blur(input);
	expect(input.value).toBe("60");
});

test("a number input takes min, max and step from the state when the view has none", async () => {
	const el = await mount(<NumberInputView request={ageInput()} />, definition);
	const input = inputOf(el, "input[type=number]");
	expect(input.min).toBe("20");
	expect(input.max).toBe("70");
});

test("the slider moves the state and formats its value", async () => {
	const el = await mount(
		<>
			<SliderView
				request={req({
					view: "slider",
					bind: "age",
					label: "年齢",
					unit: "歳",
					format: "integer",
				})}
			/>
			<StatView request={stat({ format: "integer" })} />
		</>,
		definition,
	);
	const slider = inputOf(el, "input[type=range]");
	expect(slider.min).toBe("20");
	expect(slider.max).toBe("70");
	expect(el.textContent).toContain("40歳");
	await type(slider, "60");
	expect(el.textContent).toContain("60歳");
	expect(el.textContent).toContain("5");
});

test("a slider without a range anywhere is 0 to 100", async () => {
	const el = await mount(
		<SliderView
			request={req({ view: "slider", bind: "rate", label: "利回り" })}
		/>,
		definition,
	);
	const slider = inputOf(el, "input[type=range]");
	expect(slider.min).toBe("0");
	expect(slider.max).toBe("100");
	expect(slider.value).toBe("3");
});

test("choice sets a text state, as buttons and as cards", async () => {
	const el = await mount(
		<>
			<ChoiceView
				request={req({
					view: "choice",
					bind: "plan",
					label: "プラン",
					options: ["A", "B"],
				})}
			/>
			<StatView request={stat({ expr: "plan", label: "選択中" })} />
		</>,
		definition,
	);
	const radios = () => [...el.querySelectorAll("[role=radio]")];
	expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual([
		"false",
		"false",
	]);
	await click(radios()[1] as Element);
	expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
	expect(el.textContent).toContain("B");
	const cards = await mount(
		<ChoiceView
			request={req({
				view: "choice",
				bind: "plan",
				options: ["A", "B"],
				display: "cards",
			})}
		/>,
		definition,
	);
	expect(cards.querySelector("[data-display=cards]")).not.toBeNull();
});

test("toggle flips a boolean state", async () => {
	const el = await mount(
		<>
			<ToggleView
				request={req({ view: "toggle", bind: "pro", label: "プロ" })}
			/>
			<StatView request={stat({ expr: "pro", label: "状態" })} />
		</>,
		definition,
	);
	const toggle = el.querySelector("[role=switch]") as HTMLElement;
	expect(toggle.getAttribute("aria-checked")).toBe("false");
	expect(el.textContent).toContain("いいえ");
	await click(toggle);
	expect(toggle.getAttribute("aria-checked")).toBe("true");
	expect(el.textContent).toContain("はい");
	expect(el.textContent).toContain("プロ");
});

test("stat shows a literal value as is and — for an expression that fails", async () => {
	const el = await mount(
		<>
			<StatView
				request={req({
					view: "stat",
					label: "合計",
					value: "¥1,200",
					trend: "up",
				})}
			/>
			<StatView request={stat({ label: "未知", expr: "ghost + 1" })} />
		</>,
		definition,
	);
	expect(el.textContent).toContain("¥1,200");
	expect(el.textContent).toContain("上昇");
	expect(el.textContent).toContain("—");
});

test("views of other kinds render nothing", async () => {
	const el = await mount(
		<>
			<StatView request={req({ view: "faq", items: [] })} />
			<SliderView request={req({ view: "stat", label: "x", value: "1" })} />
		</>,
		definition,
	);
	expect(el.innerHTML).toBe("");
});

test("without a model the input views render disabled and the stat shows —", async () => {
	const el = await mount(
		<>
			<NumberInputView request={ageInput()} />
			<SliderView
				request={req({ view: "slider", bind: "age", label: "年齢" })}
			/>
			<ChoiceView
				request={req({ view: "choice", bind: "plan", options: ["A", "B"] })}
			/>
			<ToggleView
				request={req({ view: "toggle", bind: "pro", label: "プロ" })}
			/>
			<StatView request={stat()} />
			<StatView request={req({ view: "stat", label: "固定", value: "42" })} />
			<StatView
				request={req({
					view: "stat",
					label: "定数式",
					expr: "1 + 1",
					format: "integer",
				})}
			/>
		</>,
	);
	expect(inputOf(el, "input[type=number]").disabled).toBe(true);
	expect(inputOf(el, "input[type=range]").disabled).toBe(true);
	expect(
		(el.querySelector("[role=switch]") as HTMLButtonElement).disabled,
	).toBe(true);
	await type(inputOf(el, "input[type=number]"), "50");
	await click(el.querySelectorAll("[role=radio]")[0] as Element);
	expect(el.textContent).toContain("—");
	expect(el.textContent).toContain("42");
	// A constant expression needs no state; the one that names a state stays "—".
	expect(el.textContent).toContain("定数式");
	expect(el.textContent).toContain("2");
	const tiles = [...el.querySelectorAll(".ds-stat-tile-value")].map(
		(node) => node.textContent,
	);
	expect(tiles).toEqual(["—", "42", "2"]);
});

test("an input bound to a state of another type or a missing state is disabled", async () => {
	const el = await mount(
		<>
			<NumberInputView request={ageInput({ bind: "plan" })} />
			<ToggleView request={req({ view: "toggle", bind: "age", label: "x" })} />
			<SliderView
				request={req({ view: "slider", bind: "ghost", label: "y" })}
			/>
		</>,
		definition,
	);
	expect(inputOf(el, "input[type=number]").disabled).toBe(true);
	expect(
		(el.querySelector("[role=switch]") as HTMLButtonElement).disabled,
	).toBe(true);
	expect(inputOf(el, "input[type=range]").disabled).toBe(true);
});

test("choice is disabled without a model and for a state that is not text", async () => {
	const choice = (bind: string) => (
		<ChoiceView
			request={req({
				view: "choice",
				bind,
				label: "選択",
				options: ["A", "B"],
			})}
		/>
	);
	const without = await mount(choice("plan"));
	for (const radio of without.querySelectorAll("[role=radio]"))
		expect((radio as HTMLButtonElement).disabled).toBe(true);
	const wrongType = await mount(choice("age"), definition);
	for (const radio of wrongType.querySelectorAll("[role=radio]"))
		expect((radio as HTMLButtonElement).disabled).toBe(true);
	const ok = await mount(choice("plan"), definition);
	for (const radio of ok.querySelectorAll("[role=radio]"))
		expect((radio as HTMLButtonElement).disabled).toBe(false);
});

test("pricing-card, comparison-table, faq and timeline render their content", async () => {
	const el = await mount(
		<>
			<PricingCardView
				request={req({
					view: "pricing-card",
					plan: "スタンダード",
					price: "¥1,200",
					period: "月",
					features: ["機能A"],
					ctaLabel: "選ぶ",
					highlighted: true,
				})}
			/>
			<ComparisonTableView
				request={req({
					view: "comparison-table",
					title: "比較",
					columns: ["X", "Y"],
					rows: [{ label: "共有", values: [false, true] }],
					highlightColumn: 1,
				})}
			/>
			<FaqView
				request={req({
					view: "faq",
					title: "質問集",
					items: [{ question: "無料ですか", answer: "はい" }],
				})}
			/>
			<TimelineView
				request={req({
					view: "timeline",
					title: "歩み",
					items: [{ label: "1603", title: "開幕" }],
				})}
			/>
		</>,
	);
	for (const text of [
		"スタンダード",
		"¥1,200",
		"おすすめ",
		"選ぶ",
		"比較",
		"あり",
		"なし",
		"無料ですか",
		"歩み",
		"開幕",
	])
		expect(el.textContent).toContain(text);
	const trigger = el.querySelector("button[aria-expanded]") as HTMLElement;
	await click(trigger);
	expect(el.textContent).toContain("はい");
});
