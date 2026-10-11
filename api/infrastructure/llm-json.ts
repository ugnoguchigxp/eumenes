import { jsonrepair } from "jsonrepair";
import { getLogger } from "./logger";

const log = getLogger("llm-json");
export class LlmJsonError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}
function reject(code = "llm_json_unsafe_repair"): never {
	throw new LlmJsonError(code);
}
type Token = { value: string; key?: string };

/** Lexical comparison only: preserve every key, scalar, colon and bracket.
 * Commas and key/string quote delimiters may change. No value inference.
 */
function tokens(text: string): Token[] {
	const result: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const char = text[i]!;
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if ("{}[]:,".includes(char)) {
			result.push({ value: char });
			i++;
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			let value = "";
			let closed = false;
			for (i++; i < text.length; i++) {
				const next = text[i]!;
				if (next === quote) {
					i++;
					closed = true;
					break;
				}
				if (next.charCodeAt(0) < 32) reject();
				if (next !== "\\") {
					value += next;
					continue;
				}
				const escaped = text[++i];
				if (quote === "'" && escaped === "'") value += "'";
				else {
					const escape = escaped === "u" ? text.slice(i, i + 5) : escaped;
					if (!escape) reject();
					try {
						value += JSON.parse(`"\\${escape}"`);
					} catch {
						reject();
					}
					if (escaped === "u") i += 4;
				}
			}
			if (!closed) reject("llm_json_incomplete");
			result.push({ value: JSON.stringify(value), key: value });
			continue;
		}
		const start = i;
		while (i < text.length && !/[\s{}[\]:,]/.test(text[i]!)) i++;
		const word = text.slice(start, i);
		// Unquoted identifiers are accepted only as object property names.
		if (/^[A-Za-z_$][\w$]*$/.test(word) && /^\s*:/.test(text.slice(i)))
			result.push({ value: JSON.stringify(word), key: word });
		else {
			try {
				const value: unknown = JSON.parse(word);
				if (
					typeof value !== "boolean" &&
					value !== null &&
					!(typeof value === "number" && Number.isFinite(value))
				)
					reject();
				result.push({ value: word });
			} catch {
				reject();
			}
		}
	}
	return result;
}

/** JSON.parse silently overwrites duplicate keys; reject them before adoption. */
function checkStructure(input: Token[]) {
	const stack: Array<{ end: string; keys: Set<string> }> = [];
	for (const [i, token] of input.entries()) {
		if (
			token.value === "," &&
			[",", "[", "{"].includes(input[i - 1]?.value ?? "")
		)
			reject();
		if (token.value === "{" || token.value === "[") {
			stack.push({ end: token.value === "{" ? "}" : "]", keys: new Set() });
			if (stack.length > 64) reject("llm_json_too_deep");
		} else if (token.value === "}" || token.value === "]") {
			if (stack.pop()?.end !== token.value) reject();
		} else if (input[i + 1]?.value === ":" && token.key !== undefined) {
			const frame = stack.at(-1);
			if (!frame || frame.end !== "}") reject();
			if (frame.keys.has(token.key)) reject("llm_json_duplicate_key");
			frame.keys.add(token.key);
		}
	}
	if (stack.length) reject("llm_json_incomplete");
}

/** Only a complete outer wrapper is removed; never extract JSON from prose. */
function bodyOf(text: string) {
	const trimmed = text.trim();
	const thought = /^<think>[\s\S]*?<\/think>\s*/i.exec(trimmed);
	const body = thought ? trimmed.slice(thought[0].length) : trimmed;
	const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
	return fence?.[1] ?? body;
}

/** One syntax correction at the LLM-output boundary. Callers own schema,
 * authority and retry validation. HTTP envelopes and stored JSON stay strict.
 */
export function decodeLlmJson(input: unknown, limit = 65536) {
	const bytes =
		typeof input === "string" ? Buffer.byteLength(input) : undefined;
	try {
		if (typeof input !== "string") reject("llm_json_non_text");
		if (bytes! > limit) reject("llm_json_too_large");
		const body = bodyOf(input);
		let value: unknown;
		let parsed = false;
		try {
			value = JSON.parse(body);
			parsed = true;
		} catch {}
		const original = tokens(body);
		checkStructure(original);
		if (parsed) return { value, repaired: false };
		let corrected: string;
		try {
			corrected = jsonrepair(body);
			value = JSON.parse(corrected);
		} catch {
			return reject("llm_json_invalid_syntax");
		}
		if (Buffer.byteLength(corrected) > limit) reject("llm_json_too_large");
		const candidate = tokens(corrected);
		checkStructure(candidate);
		const meaningful = (list: Token[]) => list.filter((t) => t.value !== ",");
		const before = meaningful(original);
		const after = meaningful(candidate);
		if (
			before.length !== after.length ||
			before.some((token, i) => token.value !== after[i]?.value)
		)
			reject();
		log.debug("llm_json.corrected", { bytes, reason: "syntax" });
		return { value, repaired: true };
	} catch (error) {
		if (error instanceof LlmJsonError)
			log.debug("llm_json.rejected", { reason: error.code, bytes, limit });
		throw error;
	}
}
export const parseLlmJson = (input: unknown, limit?: number): unknown =>
	decodeLlmJson(input, limit).value;
