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
	cyclicNames,
	parseExpression,
	reservedNames,
} from "./composition-expressions";

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

type Context = {
	states: ReadonlyMap<string, StateDefinition["type"]>;
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
) {
	if (typeof name !== "string") return;
	const actual = context.states.get(name);
	if (actual === undefined)
		reject(
			path,
			context.computed.has(name) ? "bind_not_state" : "unknown_bind",
		);
	else if (actual !== type) reject(path, "bind_type_mismatch");
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
	const states = new Map<string, StateDefinition["type"]>();
	const computed = new Map<string, "series" | "value">();
	const claim = (path: string, name: string) => {
		if (reservedNames.has(name)) reject(path, "reserved_name");
		if (states.has(name) || computed.has(name)) reject(path, "duplicate_name");
	};
	for (const [name, state] of entriesOf(model.state)) {
		claim(join(base, "state", name), name);
		states.set(name, asRecord(state).type as StateDefinition["type"]);
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
	return context;
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

function checkView(path: string, view: Record_, context: Context) {
	const expr = (key: string, value: unknown, locals?: readonly string[]) =>
		checkExpression(join(path, key), value, context, locals);
	switch (view.view) {
		case "stat":
		case "formula":
			expr("expr", view.expr);
			break;
		case "number-input":
		case "slider":
			checkBind(join(path, "bind"), view.bind, context, "number");
			break;
		case "choice":
			checkBind(join(path, "bind"), view.bind, context, "text");
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
			asArray(view.columns).forEach((column, index) =>
				checkExpression(
					join(path, "columns", index, "expr"),
					asRecord(column).expr,
					context,
					["x", "y"],
				),
			);
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
