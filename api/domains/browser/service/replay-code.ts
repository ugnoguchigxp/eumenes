import { errorLabel } from "../contracts";
import {
	REDACTED_VALUE,
	type HistoryAction,
	type HistoryReplay,
} from "../contracts/history";
import { gotoCode } from "./history-source";
import { redactedLiteral } from "./history-values";

/**
 * The code of a replay: assembled from a history's recorded operations, and checked by the host before it runs
 * (spec browser-history-replay §3.2). The check reads only the operations' code, never the wrapper. It splits the
 * code into tokens the way the JavaScript engine does and lets through a small closed language: calls of
 * Playwright's Page, Locator, Keyboard and Mouse methods on names the code itself declares. Anything the
 * tokenizer cannot split with certainty is refused, because the check and the engine must read the same tokens.
 */

const BASE_WORDS: ReadonlySet<string> = new Set([
	"page",
	"vars",
	"Math",
	"await",
	"const",
	"let",
	"true",
	"false",
	"null",
]);
/** Names that may follow a `.`: Playwright's methods and getters the recorded code uses, plus `Math.floor/random`. */
const MEMBERS: ReadonlySet<string> = new Set([
	"goBack",
	"goForward",
	"reload",
	"bringToFront",
	"url",
	"locator",
	"frameLocator",
	"contentFrame",
	"getByRole",
	"getByText",
	"getByLabel",
	"getByPlaceholder",
	"getByTestId",
	"getByTitle",
	"getByAltText",
	"first",
	"last",
	"nth",
	"filter",
	"and",
	"or",
	"count",
	"click",
	"dblclick",
	"hover",
	"focus",
	"blur",
	"fill",
	"clear",
	"press",
	"pressSequentially",
	"type",
	"check",
	"uncheck",
	"setChecked",
	"selectOption",
	"scrollIntoViewIfNeeded",
	"waitFor",
	"waitForURL",
	"waitForLoadState",
	"waitForTimeout",
	"waitForSelector",
	"keyboard",
	"mouse",
	"down",
	"up",
	"insertText",
	"move",
	"wheel",
]);
const MATH_MEMBERS: ReadonlySet<string> = new Set(["floor", "random"]);
/** Keys of the option objects those methods take. */
const OPTION_KEYS: ReadonlySet<string> = new Set([
	"name",
	"exact",
	"timeout",
	"hasText",
	"hasNotText",
	"hasNot",
	"visible",
	"has",
	"state",
	"delay",
	"force",
	"button",
	"clickCount",
	"position",
	"x",
	"y",
	"waitUntil",
	"level",
	"checked",
	"pressed",
	"selected",
	"expanded",
	"includeHidden",
	"disabled",
	"modifiers",
	"noWaitAfter",
	"trial",
	"steps",
	"url",
]);
/** Names the code must not declare: the checker reads them as the host's own (the template's `encodeURIComponent` too). */
const NO_DECLARE: ReadonlySet<string> = new Set([
	...BASE_WORDS,
	"encodeURIComponent",
]);
/** Refused wherever they appear, even as a declared name. */
const FORBIDDEN: ReadonlySet<string> = new Set([
	"evaluate",
	"evaluateHandle",
	"addInitScript",
	"exposeFunction",
	"exposeBinding",
	"route",
	"routeFromHAR",
	"setInputFiles",
	"function",
	"constructor",
	"__proto__",
	"prototype",
]);

type Part = { text: string } | { variable: string };
type Token =
	| { t: "id" | "num" | "p"; v: string }
	| { t: "str"; v: string; value: string | null }
	| { t: "tpl"; v: string; parts: Part[] | null };

const PUNCT = [
	">>>=",
	"<<=",
	">>=",
	">>>",
	"<<",
	">>",
	"...",
	"===",
	"!==",
	"**=",
	"&&=",
	"||=",
	"??=",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**",
	"(",
	")",
	"{",
	"}",
	"[",
	"]",
	",",
	";",
	":",
	".",
	"?",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"=",
	"!",
];
const SPACE = /[ \t\r\n\f\v]/;
const LINE_END = /[\n\r\u2028\u2029]/;
const TEMPLATE_VARIABLE =
	/\$\{encodeURIComponent\(vars\.([a-z][a-zA-Z0-9]{0,30})\)\}/y;

const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"`": "`",
	$: "$",
	"/": "/",
};

/** The text a string's or template's raw body stands for; null when it uses an escape this check does not read. */
function unescaped(raw: string): string | null {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = raw[++i];
		if (next === undefined) return null;
		if (SIMPLE_ESCAPES[next] !== undefined) out += SIMPLE_ESCAPES[next];
		else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
			out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
			i += 2;
		} else if (
			next === "u" &&
			/^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))
		) {
			out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
			i += 4;
		} else return null;
	}
	return out;
}

/**
 * Whether a `/` after this token is a division. Where it could start a regular expression instead (or the engine
 * could read it either way), the code is refused: regular expressions are not part of the language of a replay,
 * and reading one as a division would hide what follows it from this check.
 */
function divides(prev: Token | undefined) {
	if (!prev) return false;
	if (prev.t === "id") return prev.v !== "await";
	if (prev.t !== "p") return true;
	return prev.v === ")" || prev.v === "]";
}

/** The tokens of the code, or null when anything in it cannot be split with certainty. */
function tokenize(src: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (SPACE.test(ch)) {
			i++;
			continue;
		}
		if (src.startsWith("//", i)) {
			while (i < src.length && !LINE_END.test(src[i]!)) i++;
			continue;
		}
		if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i + 2);
			if (end === -1) return null;
			i = end + 2;
			continue;
		}
		// HTML-like comments hide the rest of a line from the engine but not from this reader.
		if (src.startsWith("<!--", i) || src.startsWith("-->", i)) return null;
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			for (;;) {
				const c = src[j];
				if (c === undefined || c === "\n" || c === "\r") return null;
				if (c === "\\") {
					const n = src[j + 1];
					if (n === undefined || n === "\n" || n === "\r") return null;
					j += 2;
					continue;
				}
				if (c === ch) break;
				j++;
			}
			tokens.push({
				t: "str",
				v: src.slice(i, j + 1),
				value: unescaped(src.slice(i + 1, j)),
			});
			i = j + 1;
			continue;
		}
		if (ch === "`") {
			const parts: Part[] = [];
			let text = "";
			let j = i + 1;
			let raw = true;
			for (;;) {
				const c = src[j];
				if (c === undefined) return null;
				if (c === "`") break;
				if (c === "\\") {
					if (src[j + 1] === undefined) return null;
					text += src.slice(j, j + 2);
					j += 2;
					continue;
				}
				if (c === "$" && src[j + 1] === "{") {
					TEMPLATE_VARIABLE.lastIndex = j;
					const m = TEMPLATE_VARIABLE.exec(src);
					if (!m) return null;
					const decoded = unescaped(text);
					if (decoded === null) raw = false;
					parts.push({ text: decoded ?? "" }, { variable: m[1]! });
					text = "";
					j += m[0].length;
					continue;
				}
				text += c;
				j++;
			}
			const decoded = unescaped(text);
			if (decoded === null) raw = false;
			parts.push({ text: decoded ?? "" });
			tokens.push({
				t: "tpl",
				v: src.slice(i, j + 1),
				parts: raw ? parts : null,
			});
			i = j + 1;
			continue;
		}
		if (/[0-9]/.test(ch)) {
			const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
			if (/[A-Za-z0-9_$\\.]/.test(src[i + m[0].length] ?? "")) return null;
			tokens.push({ t: "num", v: m[0] });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))!;
			tokens.push({ t: "id", v: m[0] });
			i += m[0].length;
			continue;
		}
		if (ch === "/" && !divides(tokens[tokens.length - 1])) return null;
		const p = PUNCT.find((candidate) => src.startsWith(candidate, i));
		if (!p) return null;
		tokens.push({ t: "p", v: p });
		i += p.length;
	}
	return tokens;
}

export type CodeCheck = { ok: true; gotoUrls: string[] } | { ok: false };
const REFUSED: CodeCheck = { ok: false };

const ASSIGNMENT: ReadonlySet<string> = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"&&=",
	"||=",
	"??=",
	"<<=",
	">>=",
	">>>=",
]);
/** Whether the `=` at `at` follows `const <name>` or `let <name>`. */
function declaresBefore(tokens: readonly Token[], at: number) {
	const keyword = tokens[at - 2];
	return (
		tokens[at - 1]?.t === "id" &&
		keyword?.t === "id" &&
		(keyword.v === "const" || keyword.v === "let")
	);
}

/** Whether a `[` after this token would read a member (`x['a']`) rather than start an array. */
function endsOperand(prev: Token | undefined) {
	if (!prev) return false;
	if (prev.t === "id") return prev.v !== "await";
	if (prev.t !== "p") return true;
	return [")", "]", "}", ".", "?."].includes(prev.v);
}

/**
 * Checks the code of a replay. `declared` are the history's variable names (each readable as `vars.<name>`);
 * `values` are what this run substitutes, used only to work out the addresses `page.goto` is given.
 */
export function checkReplayCode(
	src: string,
	declared: readonly string[],
	values: Record<string, string>,
): CodeCheck {
	const tokens = tokenize(src);
	if (!tokens) return REFUSED;
	const gotoUrls: string[] = [];
	const scopes: Set<string>[] = [new Set()];
	const open: string[] = [];
	const isP = (t: Token | undefined, ...v: string[]) =>
		t?.t === "p" && v.includes(t.v);
	const known = (name: string) => scopes.some((s) => s.has(name));

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		const prev = tokens[i - 1];
		const next = tokens[i + 1];
		if (tok.t === "tpl") {
			if (!tok.parts) return REFUSED;
			for (const part of tok.parts)
				if ("variable" in part && !declared.includes(part.variable))
					return REFUSED;
		} else if (tok.t === "id") {
			const name = tok.v;
			if (FORBIDDEN.has(name)) return REFUSED;
			if (isP(prev, ".", "?.")) {
				const owner = tokens[i - 2]?.t === "id" ? tokens[i - 2]!.v : "";
				if (owner === "vars" && isP(prev, ".")) {
					if (!declared.includes(name)) return REFUSED;
				} else if (owner === "Math") {
					if (!MATH_MEMBERS.has(name)) return REFUSED;
				} else if (name === "goto") {
					const url = gotoUrl(tokens, i, values);
					if (url === null) return REFUSED;
					gotoUrls.push(url);
				} else if (!MEMBERS.has(name)) return REFUSED;
			} else if (name === "const" || name === "let") {
				if (next?.t !== "id") return REFUSED;
				if (NO_DECLARE.has(next.v) || FORBIDDEN.has(next.v)) return REFUSED;
				scopes[scopes.length - 1]!.add(next.v);
			} else if (
				isP(prev, "{", ",") &&
				open[open.length - 1] === "{" &&
				isP(next, ":")
			) {
				if (!OPTION_KEYS.has(name)) return REFUSED;
			} else if (!BASE_WORDS.has(name) && !known(name)) return REFUSED;
		} else if (tok.t === "p") {
			if (tok.v === "=>" || tok.v === "++" || tok.v === "--") return REFUSED;
			// The only assignment is the initializer of a declaration (`const x = ...`).
			if (
				ASSIGNMENT.has(tok.v) &&
				!(tok.v === "=" && declaresBefore(tokens, i))
			)
				return REFUSED;
			if (tok.v === "[" && endsOperand(prev)) return REFUSED;
			if (tok.v === "(" || tok.v === "{" || tok.v === "[") {
				open.push(tok.v);
				if (tok.v === "{") scopes.push(new Set());
			} else if (tok.v === ")" || tok.v === "}" || tok.v === "]") {
				const want = { ")": "(", "}": "{", "]": "[" }[tok.v];
				if (open.pop() !== want) return REFUSED;
				if (tok.v === "}") scopes.pop();
			}
		}
	}
	return open.length ? REFUSED : { ok: true, gotoUrls };
}

/**
 * The address `page.goto(<string or template>)` is given with this run's values, or null when the call is not
 * that shape (`page.goto` and nothing but a literal or the allowed template as its address).
 */
function gotoUrl(
	tokens: readonly Token[],
	at: number,
	values: Record<string, string>,
): string | null {
	const dot = tokens[at - 1];
	const owner = tokens[at - 2];
	const open = tokens[at + 1];
	const arg = tokens[at + 2];
	const after = tokens[at + 3];
	if (!(dot?.t === "p" && dot.v === ".")) return null;
	if (!(owner?.t === "id" && owner.v === "page")) return null;
	if (!(open?.t === "p" && open.v === "(")) return null;
	if (!(after?.t === "p" && (after.v === ")" || after.v === ","))) return null;
	if (arg?.t === "str") return arg.value;
	if (arg?.t !== "tpl" || !arg.parts) return null;
	let url = "";
	for (const part of arg.parts) {
		if ("text" in part) url += part.text;
		else if (Object.hasOwn(values, part.variable))
			url += encodeURIComponent(values[part.variable]!);
		else return null;
	}
	return url;
}

/** The one code MCP generates that is not in the language above, written as its allowed equivalent. */
const GENERATED_WAIT =
	/^await new Promise\(f => setTimeout\(f, (\d+(?:\.\d+)?) \* 1000\)\);$/;
const normalized = (line: string) => {
	const wait = GENERATED_WAIT.exec(line);
	return wait
		? `await page.waitForTimeout(${Math.round(Number(wait[1]) * 1000)});`
		: line;
};

/**
 * The lines of a history's replay: each operation's recorded code, a navigation without code as `page.goto`,
 * and no line for a capture (it saves an image of Eumenes' own and does not change the page). Null when an
 * operation has no code to run, or would type a value the user allowed once and the history does not keep.
 */
export function replayLines(
	actions: readonly HistoryAction[],
): string[] | null {
	const lines: string[] = [];
	for (const a of [...actions].sort((x, y) => x.seq - y.seq)) {
		if (a.value === REDACTED_VALUE || a.code?.includes(redactedLiteral))
			return null;
		if (a.code) lines.push(...a.code.split("\n").map(normalized));
		else if (a.kind === "navigate" && a.url) lines.push(gotoCode(a.url));
		else if (a.kind !== "capture") return null;
	}
	return lines.length ? lines : null;
}

export type ReplayPlan =
	| { ok: true; lines: string[]; gotoUrls: string[] }
	| {
			ok: false;
			code: "replay_incomplete" | "replay_code_rejected";
			/** What would have run; empty when an operation has nothing to run. */
			lines: string[];
	  };

/**
 * Assembles and checks a history's replay. The start of a replay and the preview the screen shows both come
 * from this, so what the user confirms is what is checked and run.
 */
export function planReplay(
	actions: readonly HistoryAction[],
	declared: readonly string[],
	values: Record<string, string>,
): ReplayPlan {
	const lines = replayLines(actions);
	if (!lines) return { ok: false, code: "replay_incomplete", lines: [] };
	const checked = checkReplayCode(lines.join("\n"), declared, values);
	return checked.ok
		? { ok: true, lines, gotoUrls: checked.gotoUrls }
		: { ok: false, code: "replay_code_rejected", lines };
}

/** What the screen's confirm shows, from the reasons that do not depend on this run's values. */
export function replayPreview(
	actions: readonly HistoryAction[],
	declared: readonly string[],
): HistoryReplay {
	const placeholder = Object.fromEntries(declared.map((n) => [n, "x"]));
	const plan = planReplay(actions, declared, placeholder);
	return {
		code: plan.lines.join("\n"),
		blocked: plan.ok ? null : plan.code,
		blockedLabel: plan.ok ? null : errorLabel(plan.code),
	};
}

/** The function MCP runs: the values are JSON, frozen, and nothing in the checked code can assign. */
export function replayFunction(
	lines: readonly string[],
	values: Record<string, string>,
) {
	return `async (page) => {\n'use strict';\nconst vars = Object.freeze(${JSON.stringify(values)});\n${lines.join("\n")}\n}`;
}

/** `https://<place>` with each `{{name}}` of it replaced by the encoded value. */
export function replayTabUrl(place: string, values: Record<string, string>) {
	return `https://${place.replace(
		/\{\{([a-z][a-zA-Z0-9]{0,30})\}\}/g,
		(m, name: string) =>
			Object.hasOwn(values, name) ? encodeURIComponent(values[name]!) : m,
	)}`;
}
