/**
 * The calculator's own expression evaluation: numbers, + - * / ^, parentheses, unary minus,
 * sin cos tan (degrees), sqrt and pi. Expressions are parsed, never run as code.
 */

type Token =
	| { type: "num"; value: number }
	| { type: "op"; value: "+" | "-" | "*" | "/" | "^" }
	| { type: "id"; value: string }
	| { type: "lparen" }
	| { type: "rparen" };

const MAX_LENGTH = 500;
const MAX_DEPTH = 50;

const tokenize = (expression: string): Token[] => {
	const tokens: Token[] = [];
	const pattern =
		/\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([+\-*/^])|([a-z]+)|(\()|(\)))/iy;
	let index = 0;
	const source = expression.trimEnd();
	while (index < source.length) {
		pattern.lastIndex = index;
		const match = pattern.exec(source);
		if (!match) throw new Error("invalid");
		index = pattern.lastIndex;
		if (match[1] !== undefined) tokens.push({ type: "num", value: Number(match[1]) });
		else if (match[2] !== undefined)
			tokens.push({ type: "op", value: match[2] as "+" });
		else if (match[3] !== undefined)
			tokens.push({ type: "id", value: match[3].toLowerCase() });
		else if (match[4] !== undefined) tokens.push({ type: "lparen" });
		else tokens.push({ type: "rparen" });
	}
	return tokens;
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const isMultipleOf = (value: number, step: number) =>
	Math.abs(value / step - Math.round(value / step)) < 1e-12;

/** Degrees in, with the exact values at multiples of 90 degrees. */
const functions: Record<string, (x: number) => number> = {
	sin: (x) => (isMultipleOf(x, 180) ? 0 : Math.sin(toRadians(x))),
	cos: (x) => (isMultipleOf(x - 90, 180) ? 0 : Math.cos(toRadians(x))),
	tan: (x) => {
		if (isMultipleOf(x, 180)) return 0;
		if (isMultipleOf(x - 90, 180)) throw new Error("undefined");
		return Math.tan(toRadians(x));
	},
	sqrt: (x) => {
		if (x < 0) throw new Error("undefined");
		return Math.sqrt(x);
	},
};
const constants: Record<string, number> = { pi: Math.PI };

const finite = (value: number): number => {
	if (!Number.isFinite(value)) throw new Error("undefined");
	return value;
};

/** Evaluates `expression`; throws when it is malformed or has no finite value. */
export const evaluateExpression = (expression: string): number => {
	if (expression.length > MAX_LENGTH) throw new Error("invalid");
	const tokens = tokenize(expression);
	let position = 0;
	let depth = 0;

	const peek = () => tokens[position];
	const next = () => tokens[position++];

	const parseExpression = (): number => {
		if (++depth > MAX_DEPTH) throw new Error("invalid");
		let left = parseTerm();
		for (;;) {
			const token = peek();
			if (token?.type !== "op" || (token.value !== "+" && token.value !== "-"))
				break;
			next();
			const right = parseTerm();
			left = token.value === "+" ? left + right : left - right;
		}
		depth--;
		return finite(left);
	};

	const parseTerm = (): number => {
		let left = parseUnary();
		for (;;) {
			const token = peek();
			if (token?.type === "op" && (token.value === "*" || token.value === "/")) {
				next();
				const right = parseUnary();
				if (token.value === "/" && right === 0) throw new Error("div0");
				left = token.value === "*" ? left * right : left / right;
			} else if (token?.type === "id" || token?.type === "lparen") {
				// Implicit multiplication: 2pi, 2(3), 3sin(30).
				left *= parseUnary();
			} else {
				return finite(left);
			}
		}
	};

	const parseUnary = (): number => {
		const token = peek();
		if (token?.type === "op" && token.value === "-") {
			next();
			return -parseUnary();
		}
		return parsePower();
	};

	const parsePower = (): number => {
		const base = parsePrimary();
		const token = peek();
		if (token?.type === "op" && token.value === "^") {
			next();
			return finite(base ** parseUnary());
		}
		return base;
	};

	const parsePrimary = (): number => {
		const token = next();
		if (!token) throw new Error("invalid");
		if (token.type === "num") return token.value;
		if (token.type === "lparen") {
			const value = parseExpression();
			if (next()?.type !== "rparen") throw new Error("invalid");
			return value;
		}
		if (token.type === "id") {
			const constant = constants[token.value];
			if (constant !== undefined) return constant;
			const fn = functions[token.value];
			if (!fn || next()?.type !== "lparen") throw new Error("invalid");
			const argument = parseExpression();
			if (next()?.type !== "rparen") throw new Error("invalid");
			return fn(argument);
		}
		throw new Error("invalid");
	};

	const result = parseExpression();
	if (position !== tokens.length) throw new Error("invalid");
	// Trims float noise such as 0.1 + 0.2.
	return Number(finite(result).toPrecision(12));
};
