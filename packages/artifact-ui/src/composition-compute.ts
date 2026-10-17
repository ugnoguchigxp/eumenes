/**
 * Values of a composition's model without React: states in, computed values out (in dependency
 * order, cycles and failures as null). Shared by the renderer and the studio's checks.
 */
import type {
	CompositionModelDefinition,
	CompositionPoint,
	CompositionValue,
	StateDefinition,
} from "./composition-contracts";
import {
	type Ast,
	createBudget,
	cyclicNames,
	type EvaluationBudget,
	evaluateExpression,
	evaluationStepLimit,
	type ExpressionScope,
	parseExpression,
} from "./composition-expressions";

export const maxSeriesPoints = 1_200;
const maxTextLength = 120;
const parseCacheLimit = 500;

const parseCache = new Map<string, Ast | null>();
function parsedAst(source: string): Ast | null {
	const cached = parseCache.get(source);
	if (cached !== undefined) return cached;
	const parsed = parseExpression(source);
	if (parseCache.size >= parseCacheLimit) parseCache.clear();
	const ast = parsed.ok ? parsed.ast : null;
	parseCache.set(source, ast);
	return ast;
}

export type StateValue = number | string | boolean;
type ComputedDefinition = NonNullable<
	CompositionModelDefinition["computed"]
>[string];
type SeriesDefinition = Extract<
	ComputedDefinition,
	{ series: unknown }
>["series"];
type Values = Map<string, CompositionValue>;

export const own = <T>(
	record: Readonly<Record<string, T>> | undefined,
	name: string,
): T | undefined =>
	record && Object.hasOwn(record, name) ? record[name] : undefined;

/** A value accepted for a state of the given definition, or undefined when the type differs. */
export function acceptedValue(
	definition: StateDefinition,
	value: unknown,
): StateValue | undefined {
	if (definition.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
		return Math.min(
			definition.max ?? Infinity,
			Math.max(definition.min ?? -Infinity, value),
		);
	}
	if (definition.type === "boolean")
		return typeof value === "boolean" ? value : undefined;
	return typeof value === "string" ? value.slice(0, maxTextLength) : undefined;
}

export function scopeOf(
	values: ReadonlyMap<string, CompositionValue>,
	locals?: Readonly<Record<string, CompositionValue>>,
): ExpressionScope {
	return {
		get: (name) =>
			locals && Object.hasOwn(locals, name) ? locals[name] : values.get(name),
	};
}

export function evaluateSource(
	source: string,
	scope: ExpressionScope,
	budget: EvaluationBudget,
): CompositionValue {
	const ast = parsedAst(source);
	return ast ? evaluateExpression(ast, scope, budget) : null;
}

function numberOf(
	source: number | string,
	values: ReadonlyMap<string, CompositionValue>,
	budget: EvaluationBudget,
): number | null {
	const value =
		typeof source === "number"
			? source
			: evaluateSource(source, scopeOf(values), budget);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `{x: i, y}` for i from..to; null when a bound, the budget or any value fails. */
function computeSeries(
	definition: SeriesDefinition,
	values: ReadonlyMap<string, CompositionValue>,
	budget: EvaluationBudget,
): CompositionValue {
	const from = numberOf(definition.from, values, budget);
	const to = numberOf(definition.to, values, budget);
	const initial =
		definition.initial === undefined
			? 0
			: numberOf(definition.initial, values, budget);
	const ast = parsedAst(definition.expr);
	if (from === null || to === null || initial === null || !ast) return null;
	const first = Math.round(from);
	const last = Math.round(to);
	if (last - first + 1 > maxSeriesPoints) return null;
	const points: CompositionPoint[] = [];
	let prev = initial;
	for (let i = first; i <= last; i += 1) {
		budget.steps += 1;
		if (budget.steps > evaluationStepLimit) return null;
		const y = evaluateExpression(ast, scopeOf(values, { i, prev }), budget);
		if (typeof y !== "number") return null;
		points.push({ x: i, y });
		prev = y;
	}
	return points;
}

function sourcesOf(definition: ComputedDefinition): string[] {
	if (typeof definition === "string") return [definition];
	const { from, to, initial, expr } = definition.series;
	return [from, to, initial, expr].filter(
		(source): source is string => typeof source === "string",
	);
}

/**
 * The values of every state and computed value. Computed values are evaluated in dependency
 * order; a circular reference, a failing expression or an exhausted budget gives null.
 */
export function computeValues(
	definition: CompositionModelDefinition,
	states: ReadonlyMap<string, StateValue>,
): Values {
	const values: Values = new Map(states);
	const computed = new Map(Object.entries(definition.computed ?? {}));
	const graph = new Map<string, string[]>();
	for (const [name, entry] of computed) {
		const used = sourcesOf(entry).flatMap((source) => {
			const parsed = parseExpression(source);
			return parsed.ok ? parsed.names : [];
		});
		graph.set(
			name,
			used.filter((used) => computed.has(used)),
		);
	}
	const circular = cyclicNames(graph);
	const budget = createBudget();
	const resolve = (name: string) => {
		if (values.has(name)) return;
		const entry = computed.get(name);
		if (!entry || circular.has(name)) {
			values.set(name, null);
			return;
		}
		for (const dependency of graph.get(name) ?? []) resolve(dependency);
		values.set(
			name,
			typeof entry === "string"
				? evaluateSource(entry, scopeOf(values), budget)
				: computeSeries(entry.series, values, budget),
		);
	};
	for (const name of computed.keys()) resolve(name);
	return values;
}
