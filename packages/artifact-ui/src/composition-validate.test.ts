import { describe, expect, test } from "bun:test";
import { validateComposition } from "./composition-validate";

const model = {
	state: {
		age: { type: "number", initial: 40 },
		plan: { type: "text", initial: "a" },
		pro: { type: "boolean", initial: false },
		rate: { type: "number", initial: 3 },
	},
	computed: {
		balance: {
			series: {
				from: "age",
				to: 65,
				initial: 0,
				expr: "prev * (1 + rate / 100) + i",
			},
		},
		atRetire: "last(balance)",
	},
};
const layout = (children: unknown[], extra: Record<string, unknown> = {}) => ({
	view: "layout",
	model,
	children,
	...extra,
});
const rejected = (definition: unknown) => {
	const result = validateComposition(definition);
	if (result.ok) throw new Error("expected a rejection");
	return `${result.path} ${result.rule}`;
};

describe("accepted compositions", () => {
	test("a full composition", () => {
		const result = validateComposition(
			layout(
				[
					{ view: "number-input", bind: "age", label: "年齢" },
					{ view: "slider", bind: "rate", label: "利回り" },
					{ view: "choice", bind: "plan", options: ["a", "b"] },
					{ view: "toggle", bind: "pro", label: "pro" },
					{ view: "stat", label: "資産", expr: 'format(atRetire, "yen")' },
					{ view: "formula", tex: "x", expr: "sin(30) * age" },
					{ view: "calculator", preset: "age * 2", resultBind: "rate" },
					{
						view: "chart",
						kind: "line",
						series: [{ name: "n", from: "balance" }],
					},
					{
						view: "data-table",
						columns: [
							{ header: "年", expr: "x" },
							{ header: "額", expr: "y * 2" },
						],
						series: "balance",
					},
					{ view: "stepper", bind: "age", steps: [] },
					{
						view: "diagram",
						stepBind: "age",
						elements: [
							{
								type: "shape",
								shape: "rect",
								x: 10,
								y: "age",
								w: 20,
								h: "rate * 2",
							},
							{
								type: "polygon",
								points: [
									[0, 0],
									["age", 5],
									[9, "rate"],
								],
								origin: [1, "age"],
							},
							{
								type: "label",
								x: 5,
								y: 5,
								expr: 'format(age, "number") + " km"',
							},
						],
					},
					{
						view: "layout",
						when: "pro && age > 30",
						children: [{ view: "text-block" }],
					},
				],
				{ direction: "slides" },
			),
		);
		expect(result).toEqual({ ok: true });
	});
	test("definitions without a model or expressions", () => {
		expect(validateComposition({ view: "text-block" })).toEqual({ ok: true });
		expect(
			validateComposition({
				view: "layout",
				direction: "grid",
				children: [{ view: "stat", expr: "1 + 2" }],
			}),
		).toEqual({ ok: true });
		expect(validateComposition(null)).toEqual({ ok: true });
	});
});

describe("model position", () => {
	test("a nested layout may not hold a model", () => {
		expect(rejected(layout([{ view: "layout", model, children: [] }]))).toBe(
			"children/0/model nested_model",
		);
	});
});

describe("layout features", () => {
	test.each([
		[{ direction: "form-preview" }, "direction direction_not_allowed"],
		[{ tabs: [{ label: "a", children: [0] }] }, "tabs tabs_not_allowed"],
		[{ headerChildren: [0] }, "headerChildren header_children_not_allowed"],
		[{ draftSource: "x" }, "draftSource draft_source_not_allowed"],
		[{ headerLayout: "inline" }, "headerLayout header_layout_not_allowed"],
	])("%j", (extra, expected) => {
		expect(rejected({ view: "layout", children: [], ...extra })).toBe(expected);
		expect(rejected(layout([{ view: "layout", children: [], ...extra }]))).toBe(
			`children/0/${expected}`,
		);
	});
	test("the allowed directions pass", () => {
		for (const direction of ["stack", "grid", "tabs", "slides"])
			expect(
				validateComposition({ view: "layout", direction, children: [] }),
			).toEqual({ ok: true });
	});
});

describe("expressions", () => {
	test("syntax errors and unknown functions name the position and a rule", () => {
		expect(rejected(layout([{ view: "stat", expr: "1 +" }]))).toBe(
			"children/0/expr expression_unexpected_token",
		);
		expect(rejected(layout([{ view: "stat", expr: "eval(1)" }]))).toBe(
			"children/0/expr expression_unknown_function",
		);
		expect(rejected(layout([{ view: "stat", expr: "max()" }]))).toBe(
			"children/0/expr expression_bad_arity",
		);
		expect(rejected(layout([{ view: "stat", expr: "1".repeat(301) }]))).toBe(
			"children/0/expr expression_too_long",
		);
	});
	test("unknown names are refused in every expression place", () => {
		const unknown = "ghost + 1";
		const places: Array<[unknown, string]> = [
			[{ view: "stat", expr: unknown }, "children/0/expr"],
			[{ view: "formula", tex: "x", expr: unknown }, "children/0/expr"],
			[{ view: "calculator", preset: unknown }, "children/0/preset"],
			[{ view: "layout", when: unknown, children: [] }, "children/0/when"],
			[
				{
					view: "data-table",
					columns: [{ header: "h", expr: unknown }],
					series: "balance",
				},
				"children/0/columns/0/expr",
			],
			[
				{
					view: "diagram",
					elements: [
						{ type: "shape", shape: "rect", x: unknown, y: 1, w: 1, h: 1 },
					],
				},
				"children/0/elements/0/x",
			],
			[
				{
					view: "diagram",
					elements: [
						{
							type: "polyline",
							points: [
								[1, 1],
								[2, unknown],
							],
						},
					],
				},
				"children/0/elements/0/points/1/1",
			],
			[
				{
					view: "diagram",
					elements: [{ type: "label", x: 1, y: 1, expr: unknown }],
				},
				"children/0/elements/0/expr",
			],
			[
				{
					view: "diagram",
					elements: [
						{ type: "angle", x: 1, y: 1, from: 0, to: 1, radius: unknown },
					],
				},
				"children/0/elements/0/radius",
			],
		];
		for (const [child, path] of places)
			expect(rejected(layout([child]))).toBe(`${path} unknown_name`);
		expect(
			rejected(layout([{ view: "layout", when: "ghost", children: [] }])),
		).toBe("children/0/when unknown_name");
	});
	test("locals only exist where they are defined", () => {
		expect(rejected(layout([{ view: "stat", expr: "x" }]))).toBe(
			"children/0/expr unknown_name",
		);
		expect(rejected(layout([{ view: "stat", expr: "i" }]))).toBe(
			"children/0/expr unknown_name",
		);
		expect(
			validateComposition({
				view: "layout",
				model: {
					computed: { s: { series: { from: 1, to: 3, expr: "prev + i" } } },
				},
				children: [],
			}),
		).toEqual({ ok: true });
		expect(
			rejected({
				view: "layout",
				model: { computed: { s: { series: { from: 1, to: 3, expr: "x" } } } },
				children: [],
			}),
		).toBe("model/computed/s/series/expr unknown_name");
		expect(
			rejected({
				view: "layout",
				model: { computed: { s: { series: { from: "i", to: 3, expr: "1" } } } },
				children: [],
			}),
		).toBe("model/computed/s/series/from unknown_name");
	});
	test("names of Object.prototype are unknown, not inherited", () => {
		for (const name of ["constructor", "toString", "hasOwnProperty"])
			expect(rejected(layout([{ view: "stat", expr: name }]))).toBe(
				"children/0/expr unknown_name",
			);
	});
	test("a model without those names still validates its own references", () => {
		expect(
			rejected({
				view: "layout",
				model: { computed: { a: "ghost" } },
				children: [],
			}),
		).toBe("model/computed/a unknown_name");
	});
});

describe("model definition", () => {
	test("circular computed values are refused", () => {
		const cyclic = (computed: Record<string, unknown>) => ({
			view: "layout",
			model: { computed },
			children: [],
		});
		expect(rejected(cyclic({ a: "b", b: "a" }))).toBe(
			"model/computed/a circular_reference",
		);
		expect(rejected(cyclic({ a: "a + 1" }))).toBe(
			"model/computed/a circular_reference",
		);
		expect(
			rejected(
				cyclic({ a: { series: { from: 1, to: "b", expr: "i" } }, b: "len(a)" }),
			),
		).toBe("model/computed/a circular_reference");
		expect(
			validateComposition(cyclic({ a: "1", b: "a + 1", c: "a + b" })),
		).toEqual({ ok: true });
	});
	test("reserved and duplicate names are refused", () => {
		const named = (
			state: Record<string, unknown>,
			computed: Record<string, unknown> = {},
		) => ({
			view: "layout",
			model: { state, computed },
			children: [],
		});
		const number = { type: "number", initial: 1 };
		expect(rejected(named({ pi: number }))).toBe(
			"model/state/pi reserved_name",
		);
		expect(rejected(named({ e: number }))).toBe("model/state/e reserved_name");
		expect(rejected(named({ x: number }))).toBe("model/state/x reserved_name");
		expect(rejected(named({}, { prev: "1" }))).toBe(
			"model/computed/prev reserved_name",
		);
		expect(rejected(named({ a: number }, { a: "1" }))).toBe(
			"model/computed/a duplicate_name",
		);
	});
});

describe("binds", () => {
	test.each([
		[
			{ view: "number-input", bind: "plan", label: "l" },
			"children/0/bind bind_type_mismatch",
		],
		[
			{ view: "slider", bind: "pro", label: "l" },
			"children/0/bind bind_type_mismatch",
		],
		[
			{ view: "choice", bind: "age", options: ["a", "b"] },
			"children/0/bind bind_type_mismatch",
		],
		[
			{ view: "toggle", bind: "age", label: "l" },
			"children/0/bind bind_type_mismatch",
		],
		[
			{ view: "calculator", resultBind: "plan" },
			"children/0/resultBind bind_type_mismatch",
		],
		[
			{ view: "stepper", bind: "pro", steps: [] },
			"children/0/bind bind_type_mismatch",
		],
		[
			{ view: "diagram", stepBind: "plan", elements: [] },
			"children/0/stepBind bind_type_mismatch",
		],
		[
			{ view: "number-input", bind: "ghost", label: "l" },
			"children/0/bind unknown_bind",
		],
		[
			{ view: "calculator", resultBind: "ghost" },
			"children/0/resultBind unknown_bind",
		],
		[
			{ view: "number-input", bind: "atRetire", label: "l" },
			"children/0/bind bind_not_state",
		],
		[
			{ view: "diagram", stepBind: "balance", elements: [] },
			"children/0/stepBind bind_not_state",
		],
		[
			{ view: "chart", kind: "line", series: [{ name: "n", from: "ghost" }] },
			"children/0/series/0/from unknown_series",
		],
		[
			{
				view: "chart",
				kind: "line",
				series: [
					{ name: "a", points: [] },
					{ name: "n", from: "atRetire" },
				],
			},
			"children/0/series/1/from not_a_series",
		],
		[
			{ view: "data-table", columns: [], series: "atRetire" },
			"children/0/series not_a_series",
		],
		[
			{ view: "data-table", columns: [], series: "ghost" },
			"children/0/series unknown_series",
		],
	])("%j", (child, expected) => {
		expect(rejected(layout([child]))).toBe(expected);
	});
	test("a bind without any model is refused", () => {
		expect(
			rejected({
				view: "layout",
				children: [{ view: "toggle", bind: "a", label: "l" }],
			}),
		).toBe("children/0/bind unknown_bind");
	});
	test("paths of nested layouts are joined", () => {
		expect(
			rejected(
				layout([
					{
						view: "layout",
						children: [{ view: "text-block" }, { view: "stat", expr: "ghost" }],
					},
				]),
			),
		).toBe("children/0/children/1/expr unknown_name");
	});
	test("the result never carries a value of the definition", () => {
		const result = validateComposition(
			layout([{ view: "stat", expr: "secret_value_ghost" }]),
		);
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});

describe("tex", () => {
	const formula = (tex: string) => layout([{ view: "formula", tex }]);
	test.each([
		"\\href{x}{y}",
		"\\url{x}",
		"\\includegraphics{x}",
		"\\htmlClass{a}{b}",
		"\\htmlStyle{a}{b}",
		"\\def\\a{1}",
		"\\gdef\\a{1}",
		"\\edef\\a{1}",
		"\\xdef\\a{1}",
		"\\let\\a=b",
		"\\newcommand{\\a}{1}",
		"\\renewcommand{\\a}{1}",
		"\\providecommand{\\a}{1}",
		"\\DeclareMathOperator{\\a}{a}",
		"x = \\frac{a}{b} \\href{u}{v}",
	])("%s is refused", (tex) => {
		expect(rejected(formula(tex))).toBe(
			"children/0/tex tex_command_not_allowed",
		);
	});
	test("ordinary commands, similar names and line breaks pass", () => {
		for (const tex of [
			"d = \\frac{AB}{\\tan\\theta}",
			"\\left( x \\right) \\default \\letter \\urlish",
			"a \\\\href b",
			"\\sqrt{2} + \\sum_{i=1}^{n} i",
		])
			expect(validateComposition(formula(tex))).toEqual({ ok: true });
	});
});

describe("input ranges and choices", () => {
	const withState = (state: unknown, children: unknown[]) => ({
		view: "layout",
		model: { state: { v: state } },
		children,
	});
	const number = { type: "number", initial: 5, min: 0, max: 10 };
	test("an input may not reach outside its state's range", () => {
		const input = (extra: Record<string, unknown>) =>
			withState(number, [{ view: "slider", bind: "v", label: "l", ...extra }]);
		expect(rejected(input({ min: -1 }))).toBe(
			"children/0/min bind_range_mismatch",
		);
		expect(rejected(input({ max: 11 }))).toBe(
			"children/0/max bind_range_mismatch",
		);
		expect(validateComposition(input({ min: 2, max: 8 }))).toEqual({
			ok: true,
		});
		expect(validateComposition(input({}))).toEqual({ ok: true });
		expect(
			validateComposition(
				withState({ type: "number", initial: 5 }, [
					{ view: "number-input", bind: "v", label: "l", min: -100, max: 100 },
				]),
			),
		).toEqual({ ok: true });
		expect(
			rejected(
				withState(number, [
					{ view: "number-input", bind: "v", label: "l", max: 99 },
				]),
			),
		).toBe("children/0/max bind_range_mismatch");
	});
	test("a state whose min is above its max is refused", () => {
		expect(
			rejected(withState({ type: "number", initial: 1, min: 5, max: 2 }, [])),
		).toBe("model/state/v state_range_invalid");
	});
	test("a choice starts at an option, or at nothing", () => {
		const choice = (initial: string) =>
			withState({ type: "text", initial }, [
				{ view: "choice", bind: "v", options: ["a", "b"] },
			]);
		expect(validateComposition(choice("a"))).toEqual({ ok: true });
		expect(validateComposition(choice(""))).toEqual({ ok: true });
		expect(rejected(choice("c"))).toBe(
			"children/0/bind choice_initial_not_in_options",
		);
	});
});

describe("data-table columns", () => {
	test("rows with an expr column are refused; series needs it", () => {
		expect(
			rejected(
				layout([
					{
						view: "data-table",
						columns: [{ header: "h", expr: "1" }],
						rows: [[1]],
					},
				]),
			),
		).toBe("children/0/columns/0/expr expr_without_series");
		expect(
			validateComposition(
				layout([
					{ view: "data-table", columns: [{ header: "h" }], rows: [[1]] },
				]),
			),
		).toEqual({ ok: true });
	});
});

describe("series budget", () => {
	const series = (from: unknown, to: unknown) => ({
		series: { from, to, expr: "i" },
	});
	const modelOf = (
		computed: Record<string, unknown>,
		state: Record<string, unknown> = {},
	) => ({
		view: "layout",
		model: { state, computed },
		children: [],
	});
	test("a literal series over 1,200 points is refused", () => {
		expect(validateComposition(modelOf({ s: series(1, 1200) }))).toEqual({
			ok: true,
		});
		expect(rejected(modelOf({ s: series(1, 1201) }))).toBe(
			"model/computed/s series_too_long",
		);
	});
	test("all series together stay within 10,000 points", () => {
		const names = "abcdefghij".split("").map((n) => `s${n}`);
		const eight = Object.fromEntries(
			names.slice(0, 8).map((n) => [n, series(1, 1200)]),
		);
		expect(validateComposition(modelOf(eight))).toEqual({ ok: true });
		expect(rejected(modelOf({ ...eight, sx: series(1, 1200) }))).toBe(
			"model/computed/sx series_budget_exceeded",
		);
	});
	test("bounds that read states are tried at the initial value and the ends of the range", () => {
		const age = { type: "number", initial: 40, min: 20, max: 70 };
		expect(
			validateComposition(modelOf({ s: series("age", 65) }, { age })),
		).toEqual({ ok: true });
		const years = { type: "number", initial: 10, min: 1, max: 5000 };
		expect(rejected(modelOf({ s: series(1, "years") }, { years }))).toBe(
			"model/computed/s series_too_long",
		);
		// the initial value alone looks harmless
		expect(
			validateComposition(
				modelOf({ s: series(1, "years") }, { years: { ...years, max: 100 } }),
			),
		).toEqual({ ok: true });
	});
	test("a boolean in a bound is tried both ways", () => {
		const long = { type: "boolean", initial: false };
		expect(
			rejected(modelOf({ s: series(1, "long ? 5000 : 10") }, { long })),
		).toBe("model/computed/s series_too_long");
	});
	test("a bound that reads another computed value is not estimated", () => {
		expect(
			validateComposition(modelOf({ n: "5000", s: series(1, "n") })),
		).toEqual({ ok: true });
	});
});
