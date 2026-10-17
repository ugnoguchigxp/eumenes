/**
 * The composition expression language: a tokenizer, a recursive-descent parser and an evaluator
 * written from scratch (no eval, no Function, no dynamic import). The backend validates with
 * `parseExpression`; the renderer evaluates with `evaluateExpression`. Evaluation never throws:
 * every failure (division by zero, out of range, wrong type, unknown name, exhausted budget)
 * yields null, which is displayed as "—".
 */
import type {
	CompositionSeries,
	CompositionValue,
} from "./composition-contracts";
import { emptyValue, formatCompositionValue } from "./composition-format";

export const maxExpressionLength = 300;
export const maxExpressionDepth = 32;
export const maxStringLength = 120;
/** Steps one evaluation pass may spend: a series point costs 1, `sum` costs the series length. */
export const evaluationStepLimit = 10_000;
/** Names an expression always reads as constants or locals; a model value cannot use them. */
export const reservedNames: ReadonlySet<string> = new Set([
	"pi",
	"e",
	"true",
	"false",
	"i",
	"prev",
	"x",
	"y",
]);

export type Ast =
	| { kind: "number"; value: number }
	| { kind: "string"; value: string }
	| { kind: "boolean"; value: boolean }
	| { kind: "name"; name: string }
	| { kind: "unary"; op: "-" | "!"; arg: Ast }
	| { kind: "binary"; op: string; left: Ast; right: Ast }
	| { kind: "conditional"; test: Ast; yes: Ast; no: Ast }
	| { kind: "call"; name: string; args: Ast[] };

export type ParsedExpression =
	| {
			ok: true;
			ast: Ast;
			/** Names read as values (constants such as `pi` excluded), without duplicates. */
			names: string[];
			/** Functions called, without duplicates. */
			functions: string[];
	  }
	| { ok: false; reason: string };

// --- tokenizer ---
type Token =
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "name"; name: string }
	| { type: "op"; op: string }
	| { type: "end" };

class ParseFailure extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

const twoCharOperators = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const oneCharOperators = new Set("+-*/%^<>!?:(),");
const isDigit = (char: string | undefined) =>
	char !== undefined && char >= "0" && char <= "9";
const isLetter = (char: string | undefined) =>
	char !== undefined && /^[A-Za-z]$/.test(char);

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at]!;
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			at += 1;
			continue;
		}
		if (isDigit(char) || (char === "." && isDigit(source[at + 1]))) {
			const match = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
				source.slice(at),
			);
			const literal = match![0];
			const value = Number(literal);
			if (!Number.isFinite(value)) throw new ParseFailure("bad_number");
			tokens.push({ type: "number", value });
			at += literal.length;
			continue;
		}
		if (isLetter(char)) {
			let end = at + 1;
			while (isLetter(source[end]) || isDigit(source[end])) end += 1;
			tokens.push({ type: "name", name: source.slice(at, end) });
			at = end;
			continue;
		}
		if (char === '"') {
			let value = "";
			let end = at + 1;
			for (;;) {
				const next = source[end];
				if (next === undefined) throw new ParseFailure("unterminated_string");
				if (next === '"') break;
				if (next === "\\") {
					const escaped = source[end + 1];
					if (escaped !== '"' && escaped !== "\\")
						throw new ParseFailure("bad_escape");
					value += escaped;
					end += 2;
				} else {
					value += next;
					end += 1;
				}
				if (value.length > maxStringLength)
					throw new ParseFailure("string_too_long");
			}
			tokens.push({ type: "string", value });
			at = end + 1;
			continue;
		}
		const pair = source.slice(at, at + 2);
		if (twoCharOperators.has(pair)) {
			tokens.push({ type: "op", op: pair });
			at += 2;
			continue;
		}
		if (oneCharOperators.has(char)) {
			tokens.push({ type: "op", op: char });
			at += 1;
			continue;
		}
		throw new ParseFailure("unexpected_character");
	}
	tokens.push({ type: "end" });
	return tokens;
}

// --- functions ---
type Budget = { steps: number };
type FunctionImpl = (
	args: CompositionValue[],
	budget: Budget,
) => CompositionValue;
type FunctionSpec = { min: number; max: number; run: FunctionImpl };

const isSeries = (value: unknown): value is CompositionSeries =>
	Array.isArray(value);
const asNumber = (value: CompositionValue | undefined): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
/** A finite number (and never -0), or null. */
const finite = (value: number): number | null =>
	Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
const plainNumber = (value: number) => String(Number(value.toPrecision(12)));
/** Removes floating point noise from trigonometric results (sin(30) is 0.5, cos(90) is 0). */
const tidy = (value: number): number | null =>
	finite(Math.abs(value) < 1e-12 ? 0 : Number(value.toPrecision(12)));
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

function textOf(value: CompositionValue): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	const number = asNumber(value);
	return number === null ? null : plainNumber(number);
}

/** Rounds half away from zero, like a spreadsheet. */
function roundTo(value: number, digits: number): number | null {
	const sign = value < 0 ? -1 : 1;
	const magnitude = Math.abs(value);
	const text = String(magnitude);
	const scaled = text.includes("e")
		? Math.round(magnitude * 10 ** digits) / 10 ** digits
		: Number(`${Math.round(Number(`${text}e${digits}`))}e${-digits}`);
	return finite(sign * scaled);
}

const numbers = (args: CompositionValue[]): number[] | null => {
	const list = args.map(asNumber);
	return list.every((value) => value !== null) ? (list as number[]) : null;
};
/** A function of plain numbers; null when an argument is not a finite number. */
const numeric = (
	min: number,
	max: number,
	run: (values: number[]) => number | null,
): FunctionSpec => ({
	min,
	max,
	run: (args) => {
		const values = numbers(args);
		return values ? run(values) : null;
	},
});
const series = (
	run: (
		points: CompositionSeries,
		rest: CompositionValue[],
		budget: Budget,
	) => CompositionValue,
	min = 1,
	max = 1,
): FunctionSpec => ({
	min,
	max,
	run: (args, budget) => {
		const [first, ...rest] = args;
		return isSeries(first) ? run(first, rest, budget) : null;
	},
});
const spend = (budget: Budget, steps: number) => {
	budget.steps += steps;
	return budget.steps <= evaluationStepLimit;
};
const extreme = (pick: (values: number[]) => number): FunctionSpec => ({
	min: 1,
	max: 8,
	run: (args, budget) => {
		const [only] = args;
		if (args.length === 1 && isSeries(only)) {
			if (!spend(budget, only.length)) return null;
			const values = only.map((point) => point.y);
			return values.length ? finite(pick(values)) : null;
		}
		const values = numbers(args);
		return values ? finite(pick(values)) : null;
	},
});
const trigonometric = (run: (radians: number) => number): FunctionSpec =>
	numeric(1, 1, ([degrees]) => tidy(run(toRadians(degrees!))));
const inverse = (run: (value: number) => number): FunctionSpec =>
	numeric(1, 1, ([value]) => {
		const radians = run(value!);
		return Number.isNaN(radians) ? null : tidy(toDegrees(radians));
	});

/** Excel's PMT (end of period, no future value): money received is positive, the payment negative. */
function payment(
	rate: number,
	periods: number,
	present: number,
): number | null {
	if (periods <= 0 || rate <= -1) return null;
	if (rate === 0) return finite(-present / periods);
	const growth = (1 + rate) ** periods;
	return finite((-present * rate * growth) / (growth - 1));
}
/** Excel's FV (end of period): payments and the present value paid out are negative. */
function futureValue(
	rate: number,
	periods: number,
	paid: number,
	present: number,
): number | null {
	if (periods < 0 || rate <= -1) return null;
	if (rate === 0) return finite(-(present + paid * periods));
	const growth = (1 + rate) ** periods;
	return finite(-(present * growth + (paid * (growth - 1)) / rate));
}

const formatNames = new Set(["yen", "number", "integer", "percent"]);
const functionTable = new Map<string, FunctionSpec>([
	["min", extreme((values) => Math.min(...values))],
	["max", extreme((values) => Math.max(...values))],
	["abs", numeric(1, 1, ([value]) => finite(Math.abs(value!)))],
	[
		"round",
		numeric(1, 2, ([value, digits = 0]) =>
			Number.isInteger(digits) && Math.abs(digits) <= 15
				? roundTo(value!, digits)
				: null,
		),
	],
	["floor", numeric(1, 1, ([value]) => finite(Math.floor(value!)))],
	["ceil", numeric(1, 1, ([value]) => finite(Math.ceil(value!)))],
	[
		"sqrt",
		numeric(1, 1, ([value]) => (value! < 0 ? null : finite(Math.sqrt(value!)))),
	],
	["pow", numeric(2, 2, ([base, exponent]) => finite(base! ** exponent!))],
	[
		"log",
		numeric(1, 2, ([value, base]) => {
			if (value! <= 0) return null;
			if (base === undefined) return finite(Math.log(value!));
			return base <= 0 || base === 1
				? null
				: finite(Math.log(value!) / Math.log(base));
		}),
	],
	["exp", numeric(1, 1, ([value]) => finite(Math.exp(value!)))],
	[
		"clamp",
		numeric(3, 3, ([value, low, high]) =>
			low! > high! ? null : finite(Math.min(Math.max(value!, low!), high!)),
		),
	],
	["sin", trigonometric(Math.sin)],
	["cos", trigonometric(Math.cos)],
	[
		"tan",
		numeric(1, 1, ([degrees]) => {
			const radians = toRadians(degrees!);
			return Math.abs(Math.cos(radians)) < 1e-12
				? null
				: tidy(Math.tan(radians));
		}),
	],
	["asin", inverse(Math.asin)],
	["acos", inverse(Math.acos)],
	["atan", inverse(Math.atan)],
	[
		"atan2",
		numeric(2, 2, ([y, x]) =>
			y === 0 && x === 0 ? null : tidy(toDegrees(Math.atan2(y!, x!))),
		),
	],
	[
		"pmt",
		numeric(3, 3, ([rate, periods, present]) =>
			payment(rate!, periods!, present!),
		),
	],
	[
		"fv",
		numeric(3, 4, ([rate, periods, paid, present = 0]) =>
			futureValue(rate!, periods!, paid!, present),
		),
	],
	["last", series((points) => points.at(-1)?.y ?? null)],
	["first", series((points) => points[0]?.y ?? null)],
	[
		"at",
		series(
			(points, [index]) => {
				const position = asNumber(index);
				return position !== null && Number.isInteger(position)
					? (points[position]?.y ?? null)
					: null;
			},
			2,
			2,
		),
	],
	[
		"sum",
		series((points, _rest, budget) =>
			spend(budget, points.length)
				? finite(points.reduce((total, point) => total + point.y, 0))
				: null,
		),
	],
	[
		"len",
		{
			min: 1,
			max: 1,
			run: ([value]) =>
				isSeries(value)
					? value.length
					: typeof value === "string"
						? value.length
						: null,
		},
	],
	[
		"text",
		{
			min: 1,
			max: 1,
			run: ([value]) => (value === undefined ? null : textOf(value)),
		},
	],
	[
		"format",
		{
			min: 2,
			max: 2,
			run: ([value, name]) => {
				const number = asNumber(value);
				if (
					number === null ||
					typeof name !== "string" ||
					!formatNames.has(name)
				)
					return null;
				const text = formatCompositionValue(number, {
					format: name as "yen" | "number" | "integer" | "percent",
				});
				return text === emptyValue ? null : text;
			},
		},
	],
]);

// --- parser ---
const constants = new Map<string, Ast>([
	["pi", { kind: "number", value: Math.PI }],
	["e", { kind: "number", value: Math.E }],
	["true", { kind: "boolean", value: true }],
	["false", { kind: "boolean", value: false }],
]);
/** The deepest the recursive descent may go before the AST is measured (guards the call stack). */
const parserNestingLimit = 64;

class Parser {
	private at = 0;
	private nesting = 0;
	readonly names = new Set<string>();
	readonly functions = new Set<string>();
	constructor(private readonly tokens: Token[]) {}

	parse(): Ast {
		const ast = this.ternary();
		if (this.peek().type !== "end") throw new ParseFailure("unexpected_token");
		return ast;
	}
	private peek(): Token {
		return this.tokens[this.at]!;
	}
	private isOp(...ops: string[]): string | null {
		const token = this.peek();
		return token.type === "op" && ops.includes(token.op) ? token.op : null;
	}
	private expect(op: string) {
		if (!this.isOp(op)) throw new ParseFailure("unexpected_token");
		this.at += 1;
	}
	private nested<T>(parse: () => T): T {
		this.nesting += 1;
		if (this.nesting > parserNestingLimit) throw new ParseFailure("too_deep");
		try {
			return parse();
		} finally {
			this.nesting -= 1;
		}
	}
	private ternary(): Ast {
		return this.nested(() => {
			const test = this.binary(0);
			if (!this.isOp("?")) return test;
			this.at += 1;
			const yes = this.ternary();
			this.expect(":");
			const no = this.ternary();
			return { kind: "conditional", test, yes, no };
		});
	}
	private static readonly levels: readonly (readonly string[])[] = [
		["||"],
		["&&"],
		["==", "!="],
		["<", "<=", ">", ">="],
		["+", "-"],
		["*", "/", "%"],
	];
	/** Left-associative binary operators, loosest level first. */
	private binary(level: number): Ast {
		if (level >= Parser.levels.length) return this.unary();
		let left = this.binary(level + 1);
		for (
			let op = this.isOp(...Parser.levels[level]!);
			op;
			op = this.isOp(...Parser.levels[level]!)
		) {
			this.at += 1;
			left = { kind: "binary", op, left, right: this.binary(level + 1) };
		}
		return left;
	}
	private unary(): Ast {
		return this.nested(() => {
			const op = this.isOp("-", "!");
			if (!op) return this.power();
			this.at += 1;
			return { kind: "unary", op: op as "-" | "!", arg: this.unary() };
		});
	}
	/** `^` is right-associative and binds tighter than unary minus on its left: -2^2 is -4. */
	private power(): Ast {
		const base = this.primary();
		if (!this.isOp("^")) return base;
		this.at += 1;
		return { kind: "binary", op: "^", left: base, right: this.unary() };
	}
	private primary(): Ast {
		const token = this.peek();
		this.at += 1;
		if (token.type === "number") return { kind: "number", value: token.value };
		if (token.type === "string") return { kind: "string", value: token.value };
		if (token.type === "op" && token.op === "(") {
			const inner = this.ternary();
			this.expect(")");
			return inner;
		}
		if (token.type !== "name") throw new ParseFailure("unexpected_token");
		if (this.isOp("(")) return this.call(token.name);
		const constant = constants.get(token.name);
		if (constant) return constant;
		this.names.add(token.name);
		return { kind: "name", name: token.name };
	}
	private call(name: string): Ast {
		const spec = functionTable.get(name);
		if (!spec) throw new ParseFailure("unknown_function");
		this.expect("(");
		const args: Ast[] = [];
		if (!this.isOp(")")) {
			args.push(this.ternary());
			while (this.isOp(",")) {
				this.at += 1;
				args.push(this.ternary());
			}
		}
		this.expect(")");
		if (args.length < spec.min || args.length > spec.max)
			throw new ParseFailure("bad_arity");
		this.functions.add(name);
		return { kind: "call", name, args };
	}
}

function astDepth(node: Ast): number {
	switch (node.kind) {
		case "unary":
			return 1 + astDepth(node.arg);
		case "binary":
			return 1 + Math.max(astDepth(node.left), astDepth(node.right));
		case "conditional":
			return (
				1 + Math.max(astDepth(node.test), astDepth(node.yes), astDepth(node.no))
			);
		case "call":
			return 1 + Math.max(0, ...node.args.map(astDepth));
		default:
			return 1;
	}
}

/** Parses an expression; the result lists the names and functions it uses for validation. */
export function parseExpression(source: string): ParsedExpression {
	if (source.length === 0 || source.trim().length === 0)
		return { ok: false, reason: "empty" };
	if (source.length > maxExpressionLength)
		return { ok: false, reason: "too_long" };
	try {
		const parser = new Parser(tokenize(source));
		const ast = parser.parse();
		if (astDepth(ast) > maxExpressionDepth)
			return { ok: false, reason: "too_deep" };
		return {
			ok: true,
			ast,
			names: [...parser.names],
			functions: [...parser.functions],
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof ParseFailure ? error.reason : "syntax",
		};
	}
}

// --- evaluator ---
export type ExpressionScope = {
	/** The value of a name; undefined when it does not exist. Looked up by Map or `Object.hasOwn`. */
	get(name: string): CompositionValue | undefined;
};
export type EvaluationBudget = Budget;
export const createBudget = (): EvaluationBudget => ({ steps: 0 });

function arithmetic(op: string, left: number, right: number): number | null {
	switch (op) {
		case "+":
			return finite(left + right);
		case "-":
			return finite(left - right);
		case "*":
			return finite(left * right);
		case "/":
			return right === 0 ? null : finite(left / right);
		case "%":
			return right === 0 ? null : finite(left % right);
		default:
			return finite(left ** right);
	}
}
function compare(op: string, left: number | string, right: number | string) {
	switch (op) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		default:
			return left >= right;
	}
}

function binary(
	op: string,
	left: CompositionValue,
	right: CompositionValue,
): CompositionValue {
	if (left === null || right === null) return null;
	if (isSeries(left) || isSeries(right)) return null;
	if (op === "==" || op === "!=") {
		const same = left === right;
		return op === "==" ? same : !same;
	}
	if (op === "+" && (typeof left === "string" || typeof right === "string")) {
		const a = textOf(left);
		const b = textOf(right);
		return a === null || b === null ? null : a + b;
	}
	if (op === "<" || op === "<=" || op === ">" || op === ">=") {
		if (typeof left === "number" && typeof right === "number")
			return compare(op, left, right);
		if (typeof left === "string" && typeof right === "string")
			return compare(op, left, right);
		return null;
	}
	return typeof left === "number" && typeof right === "number"
		? arithmetic(op, left, right)
		: null;
}

function run(
	node: Ast,
	scope: ExpressionScope,
	budget: Budget,
): CompositionValue {
	switch (node.kind) {
		case "number":
		case "string":
		case "boolean":
			return node.value;
		case "name":
			return scope.get(node.name) ?? null;
		case "unary": {
			const value = run(node.arg, scope, budget);
			if (node.op === "-")
				return typeof value === "number" ? finite(-value) : null;
			return typeof value === "boolean" ? !value : null;
		}
		case "conditional": {
			const test = run(node.test, scope, budget);
			if (typeof test !== "boolean") return null;
			return run(test ? node.yes : node.no, scope, budget);
		}
		case "call": {
			const args = node.args.map((arg) => run(arg, scope, budget));
			if (args.some((arg) => arg === null)) return null;
			return functionTable.get(node.name)?.run(args, budget) ?? null;
		}
		case "binary": {
			if (node.op === "&&" || node.op === "||") {
				const left = run(node.left, scope, budget);
				if (typeof left !== "boolean") return null;
				if (left === (node.op === "||")) return left;
				const right = run(node.right, scope, budget);
				return typeof right === "boolean" ? right : null;
			}
			return binary(
				node.op,
				run(node.left, scope, budget),
				run(node.right, scope, budget),
			);
		}
	}
}

/** Evaluates a parsed expression; null on any failure, never throws. */
export function evaluateExpression(
	ast: Ast,
	scope: ExpressionScope,
	budget: EvaluationBudget = createBudget(),
): CompositionValue {
	try {
		return run(ast, scope, budget);
	} catch {
		return null;
	}
}

/**
 * The names of a dependency graph that lie on a cycle (reach themselves). Edges to names that
 * are not keys of the graph are ignored.
 */
export function cyclicNames(
	graph: ReadonlyMap<string, readonly string[]>,
): Set<string> {
	const cyclic = new Set<string>();
	for (const start of graph.keys()) {
		const seen = new Set<string>();
		const pending = [...(graph.get(start) ?? [])];
		while (pending.length) {
			const name = pending.pop()!;
			if (name === start) {
				cyclic.add(start);
				break;
			}
			if (seen.has(name) || !graph.has(name)) continue;
			seen.add(name);
			pending.push(...graph.get(name)!);
		}
	}
	return cyclic;
}
