import { REDACTED_VALUE } from "../contracts/history";

/**
 * Values that change per run stay out of a history (spec browser-run-history §3.2, §5): the places that could
 * carry one are rewritten to `{{name}}`, `vars.<name>` or the redaction text. Nothing here decides which
 * values are variables; the page operator declared them in the Script.
 */
export type VarValue = { name: string; value: string };

/** One ASCII character would match inside any word; anything longer, or any non-ASCII character, is a value. */
const significant = (value: string) =>
	value.length >= 2 || [...value].some((c) => c.charCodeAt(0) > 0x7f);

/**
 * A text in the form values are compared in: every character (with its combining marks) in NFKC, lower case.
 * `starts` and `ends` tell, for each character of the folded text, which part of the original it came from.
 */
type Folded = { text: string; starts: number[]; ends: number[] };
const unit = /\P{M}\p{M}*|\p{M}+/gu;
function fold(text: string): Folded {
	const out: Folded = { text: "", starts: [], ends: [] };
	for (const m of text.matchAll(unit)) {
		const folded = m[0].normalize("NFKC").toLowerCase();
		for (let k = 0; k < folded.length; k++) {
			out.starts.push(m.index);
			out.ends.push(m.index + m[0].length);
		}
		out.text += folded;
	}
	return out;
}

/** Longest values first, so a value that contains another is replaced whole. */
const ordered = (vars: readonly VarValue[]) =>
	vars
		.filter((v) => significant(v.value))
		.map((v) => ({ name: v.name, pattern: fold(v.value).text }))
		.filter((v) => v.pattern)
		.sort((a, b) => b.pattern.length - a.pattern.length);

type Span = { start: number; end: number; name: string };

/**
 * The one matcher: where the text holds a value. Case and width (NFKC) do not matter; a longer value takes
 * its place before a shorter one that overlaps it.
 */
function spansOf(text: string, vars: readonly VarValue[]): Span[] {
	const folded = fold(text);
	const spans: Span[] = [];
	for (const v of ordered(vars))
		for (
			let at = folded.text.indexOf(v.pattern);
			at !== -1;
			at = folded.text.indexOf(v.pattern, at + 1)
		) {
			const start = folded.starts[at]!;
			const end = folded.ends[at + v.pattern.length - 1]!;
			if (spans.some((s) => start < s.end && s.start < end)) continue;
			spans.push({ start, end, name: v.name });
		}
	return spans.sort((a, b) => a.start - b.start);
}

/** Whether the text contains a value. */
export const containsValue = (text: string, vars: readonly VarValue[]) =>
	spansOf(text, vars).length > 0;

/** The text with every value replaced by `{{name}}`. */
export function replaceValues(text: string, vars: readonly VarValue[]) {
	let out = "";
	let last = 0;
	for (const s of spansOf(text, vars)) {
		out += `${text.slice(last, s.start)}{{${s.name}}}`;
		last = s.end;
	}
	return out + text.slice(last);
}

/**
 * One URL component with the values replaced. It is compared decoded (a value is what the page showed, not
 * how the URL spelled it); a component with a hit is written again with its other parts encoded.
 */
function maskComponent(raw: string, vars: readonly VarValue[], plus: boolean) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(plus ? raw.replace(/\+/g, " ") : raw);
	} catch {
		return replaceValues(raw, vars);
	}
	const spans = spansOf(decoded, vars);
	if (!spans.length) return replaceValues(raw, vars);
	let out = "";
	let last = 0;
	for (const s of spans) {
		out += `${encodeURIComponent(decoded.slice(last, s.start))}{{${s.name}}}`;
		last = s.end;
	}
	return out + encodeURIComponent(decoded.slice(last));
}

const urlParts = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/is;

/**
 * A URL with every path segment, query value and fragment that holds a variable's value showing `{{name}}`
 * instead; the rest stays as given.
 */
export function maskUrl(url: string, vars: readonly VarValue[]) {
	const m = urlParts.exec(url);
	if (!m) return replaceValues(url, vars);
	const [, origin = "", path = "", query, hash] = m;
	const segments = path
		.split("/")
		.map((segment) => maskComponent(segment, vars, false));
	const params = query
		?.slice(1)
		.split("&")
		.map((part) => {
			const eq = part.indexOf("=");
			return eq === -1
				? part
				: `${part.slice(0, eq + 1)}${maskComponent(part.slice(eq + 1), vars, true)}`;
		});
	return `${origin}${segments.join("/")}${params ? `?${params.join("&")}` : ""}${
		hash ? `#${maskComponent(hash.slice(1), vars, false)}` : ""
	}`;
}

/** A place (host and path, no scheme) with the values replaced. */
export const maskPlace = (place: string, vars: readonly VarValue[]) =>
	maskUrl(`https://${place}`, vars).slice("https://".length);

type Literal = { start: number; end: number; quote: string; inner: string };

/** The string literal that starts at `from` (`'`, `"` or a backtick), or null. */
function literalAt(code: string, from: number): Literal | null {
	const quote = code[from];
	if (quote !== "'" && quote !== '"' && quote !== "`") return null;
	for (let i = from + 1; i < code.length; i++) {
		if (code[i] === "\\") i++;
		else if (code[i] === quote)
			return { start: from, end: i + 1, quote, inner: code.slice(from + 1, i) };
	}
	return null;
}

const variableArgument = /vars\.[a-z][a-zA-Z0-9]*/y;

/** Where the call argument that starts at `from` ends: a string literal or a `vars.<name>`; -1 for anything else. */
function argumentEnd(code: string, from: number) {
	const lit = literalAt(code, from);
	if (lit) return lit.end;
	variableArgument.lastIndex = from;
	const m = variableArgument.exec(code);
	return m ? from + m[0].length : -1;
}

/** Replaces the first argument of the calls that type text (`fill`, `pressSequentially`) with `replacement`. */
export function replaceTypedArgument(code: string, replacement: string) {
	const call = /\.(?:fill|pressSequentially)\(\s*/g;
	let out = "";
	let last = 0;
	for (let m = call.exec(code); m; m = call.exec(code)) {
		const from = m.index + m[0].length;
		const end = argumentEnd(code, from);
		if (end === -1) continue;
		out += code.slice(last, from) + replacement;
		last = end;
		call.lastIndex = end;
	}
	return out + code.slice(last);
}

const ESCAPED: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

/** A literal with the values replaced: `vars.<name>` when it is a value, `{{name}}` where one is inside. */
function maskLiteral(lit: Literal, vars: readonly VarValue[]) {
	// The text the literal means, each of its characters tied to the source it was written with.
	let text = "";
	const from: number[] = [];
	const to: number[] = [];
	for (let k = 0; k < lit.inner.length; k++) {
		const start = k;
		let ch = lit.inner[k]!;
		if (ch === "\\" && k + 1 < lit.inner.length) {
			k++;
			ch = ESCAPED[lit.inner[k]!] ?? lit.inner[k]!;
		}
		text += ch;
		from.push(start);
		to.push(k + 1);
	}
	const spans = spansOf(text, vars);
	if (!spans.length) return `${lit.quote}${lit.inner}${lit.quote}`;
	const whole = spans[0]!;
	if (whole.start === 0 && whole.end === text.length)
		return `vars.${whole.name}`;
	let out = "";
	let last = 0;
	for (const s of spans) {
		const before = lit.inner.slice(last, from[s.start]);
		// `${` would open an interpolation in a template literal.
		const hole = lit.quote === "`" && (before || out).endsWith("$");
		out += `${before}${hole ? "\\" : ""}{{${s.name}}}`;
		last = to[s.end - 1]!;
	}
	return `${lit.quote}${out}${lit.inner.slice(last)}${lit.quote}`;
}

/**
 * Code with the values removed, only inside its string literals: a literal equal to a value becomes
 * `vars.<name>`, a value inside other text becomes `{{name}}`. Identifiers and punctuation stay as they are.
 */
export function maskCode(code: string, vars: readonly VarValue[]) {
	let out = "";
	let i = 0;
	while (i < code.length) {
		const lit = literalAt(code, i);
		if (!lit) {
			out += code[i];
			i++;
			continue;
		}
		out += maskLiteral(lit, vars);
		i = lit.end;
	}
	return out;
}

/** The redaction as a JS string literal. */
export const redactedLiteral = `'${REDACTED_VALUE}'`;
