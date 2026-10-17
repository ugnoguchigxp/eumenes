/**
 * The meaning checks of a UI studio composition, run beside the schema (`parseDefinition`) when
 * a definition is saved or a draft is applied: where `model` may appear, which layout features
 * are refused, that every expression parses with known names and functions, that computed values
 * do not refer to each other in a circle and that every `bind` points at a state of the right
 * type. The result names a position and a short rule, never a value of the definition.
 */
import type { StateDefinition } from "./composition-contracts";
import { compositionDirections } from "./composition-contracts";
import {
	createBudget,
	cyclicNames,
	evaluationStepLimit,
	parseExpression,
	reservedNames,
} from "./composition-expressions";
import {
	evaluateSource,
	maxSeriesPoints,
	scopeOf,
	type StateValue,
} from "./composition-compute";

export type CompositionValidation =
	| { ok: true }
	| { ok: false; path: string; rule: string };

class Rejection extends Error {
	constructor(
		readonly path: string,
		readonly rule: string,
	) {
		super(rule);
	}
}
const reject = (path: string, rule: string): never => {
	throw new Rejection(path, rule);
};
const join = (base: string, ...keys: Array<string | number>) =>
	[base, ...keys].filter((key) => key !== "").join("/");

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Record_ => (isRecord(value) ? value : {});
const asArray = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];
const entriesOf = (value: unknown): Array<[string, unknown]> =>
	isRecord(value) ? Object.entries(value) : [];

type StateInfo = {
	type: StateDefinition["type"];
	initial: StateValue | undefined;
	min: number | undefined;
	max: number | undefined;
};
type Context = {
	states: ReadonlyMap<string, StateInfo>;
	computed: ReadonlyMap<string, "series" | "value">;
};
const emptyContext: Context = { states: new Map(), computed: new Map() };

/** Layout features of the existing tab workspaces that a free composition may not use. */
const refusedLayoutKeys = [
	["tabs", "tabs_not_allowed"],
	["headerChildren", "header_children_not_allowed"],
	["draftSource", "draft_source_not_allowed"],
	["headerLayout", "header_layout_not_allowed"],
] as const;

function checkExpression(
	path: string,
	source: unknown,
	context: Context,
	locals: readonly string[] = [],
): string[] {
	if (typeof source !== "string") return [];
	const parsed = parseExpression(source);
	if (!parsed.ok) return reject(path, `expression_${parsed.reason}`);
	for (const name of parsed.names)
		if (
			!locals.includes(name) &&
			!context.states.has(name) &&
			!context.computed.has(name)
		)
			reject(path, "unknown_name");
	return parsed.names;
}

function checkBind(
	path: string,
	name: unknown,
	context: Context,
	type: StateDefinition["type"],
): StateInfo | undefined {
	if (typeof name !== "string") return undefined;
	const actual = context.states.get(name);
	if (actual === undefined)
		return reject(
			path,
			context.computed.has(name) ? "bind_not_state" : "unknown_bind",
		);
	if (actual.type !== type) return reject(path, "bind_type_mismatch");
	return actual;
}

/** An input's own min/max may not reach outside the state's (checked where both are given). */
function checkInputRange(
	path: string,
	view: Record_,
	state: StateInfo | undefined,
) {
	if (!state) return;
	const { min, max } = view;
	if (typeof min === "number" && state.min !== undefined && min < state.min)
		reject(join(path, "min"), "bind_range_mismatch");
	if (typeof max === "number" && state.max !== undefined && max > state.max)
		reject(join(path, "max"), "bind_range_mismatch");
}

/** The text a choice starts with (its state's initial value) must be one of its options. */
function checkChoice(
	path: string,
	view: Record_,
	state: StateInfo | undefined,
) {
	if (
		state &&
		typeof state.initial === "string" &&
		state.initial !== "" &&
		!asArray(view.options).includes(state.initial)
	)
		reject(join(path, "bind"), "choice_initial_not_in_options");
}

function checkSeriesName(path: string, name: unknown, context: Context) {
	if (typeof name !== "string") return;
	const kind = context.computed.get(name);
	if (kind === undefined) reject(path, "unknown_series");
	else if (kind !== "series") reject(path, "not_a_series");
}

/** Reads the root layout's `model` into a context, checking every computed expression. */
function checkModel(model: unknown, base: string): Context {
	if (!isRecord(model)) return emptyContext;
	const states = new Map<string, StateInfo>();
	const computed = new Map<string, "series" | "value">();
	const claim = (path: string, name: string) => {
		if (reservedNames.has(name)) reject(path, "reserved_name");
		if (states.has(name) || computed.has(name)) reject(path, "duplicate_name");
	};
	for (const [name, state] of entriesOf(model.state)) {
		const path = join(base, "state", name);
		claim(path, name);
		const record = asRecord(state);
		const number = (value: unknown) =>
			typeof value === "number" ? value : undefined;
		const info: StateInfo = {
			type: record.type as StateDefinition["type"],
			initial: ["number", "string", "boolean"].includes(typeof record.initial)
				? (record.initial as StateValue)
				: undefined,
			min: number(record.min),
			max: number(record.max),
		};
		if (info.min !== undefined && info.max !== undefined && info.min > info.max)
			reject(path, "state_range_invalid");
		states.set(name, info);
	}
	for (const [name, entry] of entriesOf(model.computed)) {
		claim(join(base, "computed", name), name);
		computed.set(name, typeof entry === "string" ? "value" : "series");
	}
	const context: Context = { states, computed };
	const graph = new Map<string, string[]>();
	for (const [name, entry] of entriesOf(model.computed)) {
		const path = join(base, "computed", name);
		if (typeof entry === "string") {
			graph.set(name, checkExpression(path, entry, context));
			continue;
		}
		const series = asRecord(asRecord(entry).series);
		const used = (["from", "to", "initial"] as const).flatMap((key) =>
			checkExpression(join(path, "series", key), series[key], context),
		);
		used.push(
			...checkExpression(join(path, "series", "expr"), series.expr, context, [
				"i",
				"prev",
			]),
		);
		graph.set(name, used);
	}
	const [first] = cyclicNames(graph);
	if (first !== undefined)
		reject(join(base, "computed", first), "circular_reference");
	checkSeriesBudget(model, base, context);
	return context;
}

/** How many corner combinations of the states a bound depends on are tried (3 values each). */
const maxBoundCombinations = 729;

/** The state values worth trying for a bound: the initial value and the ends of the range. */
function boundCandidates(info: StateInfo): StateValue[] {
	if (info.type === "boolean") return [true, false];
	if (info.type === "text")
		return info.initial === undefined ? [] : [info.initial];
	return [...new Set([info.initial, info.min, info.max])].filter(
		(value): value is number => typeof value === "number",
	);
}

/**
 * The most points a series can have. A literal bound is exact; an expression bound is worked
 * out for the initial values and the ends of the ranges of the states it reads (one corner at a
 * time), which is an estimate: a value in the middle of a range, or a bound that reads another
 * computed value, is not tried. Returns 0 when the bounds cannot be worked out.
 */
function mostPoints(series: Record_, context: Context): number {
	const sources = [series.from, series.to].filter(
		(source): source is string => typeof source === "string",
	);
	const read = [
		...new Set(
			sources.flatMap((source) => {
				const parsed = parseExpression(source);
				return parsed.ok ? parsed.names : [];
			}),
		),
	].filter((name) => context.states.has(name));
	const candidates = read.map((name) =>
		boundCandidates(context.states.get(name)!),
	);
	let combinations = candidates.reduce((count, list) => count * list.length, 1);
	const initialOnly = combinations > maxBoundCombinations;
	if (initialOnly) combinations = 1;
	const base = new Map<string, StateValue>();
	for (const [name, info] of context.states)
		if (info.initial !== undefined) base.set(name, info.initial);
	let most = 0;
	for (let combination = 0; combination < combinations; combination += 1) {
		const values = new Map(base);
		let rest = combination;
		read.forEach((name, index) => {
			const list = candidates[index]!;
			if (!initialOnly && list.length) {
				values.set(name, list[rest % list.length]!);
				rest = Math.floor(rest / list.length);
			}
		});
		const bound = (source: unknown) => {
			const value =
				typeof source === "number"
					? source
					: typeof source === "string"
						? evaluateSource(source, scopeOf(values), createBudget())
						: null;
			return typeof value === "number" && Number.isFinite(value)
				? Math.round(value)
				: null;
		};
		const from = bound(series.from);
		const to = bound(series.to);
		if (from !== null && to !== null) most = Math.max(most, to - from + 1);
	}
	return most;
}

/** A series over 1,200 points, or all series together over the step budget, would turn null. */
function checkSeriesBudget(model: Record_, base: string, context: Context) {
	let total = 0;
	for (const [name, entry] of entriesOf(model.computed)) {
		if (typeof entry === "string") continue;
		const points = mostPoints(asRecord(asRecord(entry).series), context);
		const path = join(base, "computed", name);
		if (points > maxSeriesPoints) reject(path, "series_too_long");
		total += points;
		if (total > evaluationStepLimit) reject(path, "series_budget_exceeded");
	}
}

const diagramNumberKeys = [
	"x",
	"y",
	"w",
	"h",
	"rotate",
	"x1",
	"y1",
	"x2",
	"y2",
	"from",
	"to",
	"radius",
	"expr",
];

function checkDiagramElement(path: string, element: unknown, context: Context) {
	const record = asRecord(element);
	for (const key of diagramNumberKeys)
		checkExpression(join(path, key), record[key], context);
	const tuples: Array<[string, unknown[]]> = [
		...asArray(record.points).map((point, index): [string, unknown[]] => [
			join(path, "points", index),
			asArray(point),
		]),
		...(record.origin === undefined
			? []
			: [
					[join(path, "origin"), asArray(record.origin)] as [string, unknown[]],
				]),
	];
	for (const [tuplePath, tuple] of tuples)
		tuple.forEach((value, index) =>
			checkExpression(join(tuplePath, index), value, context),
		);
}

const forbiddenTexCommand =
	/^(?:href|url|includegraphics|html[A-Za-z]*|def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|DeclareMathOperator)$/;

/** Rejects TeX commands that link, fetch or define macros (KaTeX is also configured to refuse them). */
function checkTex(path: string, tex: unknown) {
	if (typeof tex !== "string") return;
	// "\\" is a line break, so its second backslash does not start a command.
	for (const match of tex.matchAll(/\\(?:([A-Za-z]+)|[^A-Za-z])/g))
		if (match[1] && forbiddenTexCommand.test(match[1]))
			reject(path, "tex_command_not_allowed");
}

function checkView(path: string, view: Record_, context: Context) {
	const expr = (key: string, value: unknown, locals?: readonly string[]) =>
		checkExpression(join(path, key), value, context, locals);
	switch (view.view) {
		case "stat":
			expr("expr", view.expr);
			break;
		case "formula":
			checkTex(join(path, "tex"), view.tex);
			expr("expr", view.expr);
			break;
		case "number-input":
		case "slider":
			checkInputRange(
				path,
				view,
				checkBind(join(path, "bind"), view.bind, context, "number"),
			);
			break;
		case "choice":
			checkChoice(
				path,
				view,
				checkBind(join(path, "bind"), view.bind, context, "text"),
			);
			break;
		case "toggle":
			checkBind(join(path, "bind"), view.bind, context, "boolean");
			break;
		case "calculator":
			expr("preset", view.preset);
			checkBind(join(path, "resultBind"), view.resultBind, context, "number");
			break;
		case "stepper":
			checkBind(join(path, "bind"), view.bind, context, "number");
			break;
		case "diagram":
			checkBind(join(path, "stepBind"), view.stepBind, context, "number");
			asArray(view.elements).forEach((element, index) =>
				checkDiagramElement(join(path, "elements", index), element, context),
			);
			break;
		case "chart":
			asArray(view.series).forEach((entry, index) =>
				checkSeriesName(
					join(path, "series", index, "from"),
					asRecord(entry).from,
					context,
				),
			);
			break;
		case "data-table":
			checkSeriesName(join(path, "series"), view.series, context);
			asArray(view.columns).forEach((column, index) => {
				if (view.rows !== undefined && asRecord(column).expr !== undefined)
					reject(join(path, "columns", index, "expr"), "expr_without_series");
				checkExpression(
					join(path, "columns", index, "expr"),
					asRecord(column).expr,
					context,
					["x", "y"],
				);
			});
			break;
	}
}

function checkNode(node: unknown, path: string, root: boolean, outer: Context) {
	if (!isRecord(node)) return;
	if (node.view !== "layout") return checkView(path, node, outer);
	let context = outer;
	if (node.model !== undefined) {
		if (!root) reject(join(path, "model"), "nested_model");
		context = checkModel(node.model, join(path, "model"));
	}
	if (
		node.direction !== undefined &&
		!(compositionDirections as readonly unknown[]).includes(node.direction)
	)
		reject(join(path, "direction"), "direction_not_allowed");
	for (const [key, rule] of refusedLayoutKeys)
		if (node[key] !== undefined) reject(join(path, key), rule);
	checkExpression(join(path, "when"), node.when, context);
	asArray(node.children).forEach((child, index) =>
		checkNode(child, join(path, "children", index), false, context),
	);
}

/** Checks the meaning of a parsed composition definition; see the file comment for the rules. */
export function validateComposition(
	definition: unknown,
): CompositionValidation {
	try {
		checkNode(definition, "", true, emptyContext);
		return { ok: true };
	} catch (error) {
		if (error instanceof Rejection)
			return { ok: false, path: error.path, rule: error.rule };
		throw error;
	}
}
