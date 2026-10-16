type JsonTokenType =
	| "key"
	| "string"
	| "number"
	| "literal"
	| "punct"
	| "space";
export type JsonToken = { type: JsonTokenType; text: string };

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const LITERAL = /^(?:true|false|null)/;

/** The end (exclusive) of the string literal that opens at `start`, escapes included. */
function stringEnd(line: string, start: number) {
	let i = start + 1;
	while (i < line.length) {
		if (line[i] === "\\") i += 2;
		else if (line[i] === '"') return i + 1;
		else i += 1;
	}
	return line.length;
}

function tokenizeLine(line: string): JsonToken[] {
	const tokens: JsonToken[] = [];
	let i = 0;
	while (i < line.length) {
		const char = line[i]!;
		if (char === " " || char === "\t") {
			let end = i;
			while (line[end] === " " || line[end] === "\t") end += 1;
			tokens.push({ type: "space", text: line.slice(i, end) });
			i = end;
		} else if (char === '"') {
			const end = stringEnd(line, i);
			// A string followed by a colon names a property.
			const key = /^\s*:/.test(line.slice(end));
			tokens.push({ type: key ? "key" : "string", text: line.slice(i, end) });
			i = end;
		} else {
			const rest = line.slice(i);
			const match = NUMBER.exec(rest) ?? LITERAL.exec(rest);
			if (match) {
				tokens.push({
					type: NUMBER.test(rest) ? "number" : "literal",
					text: match[0],
				});
				i += match[0].length;
			} else {
				tokens.push({ type: "punct", text: char });
				i += 1;
			}
		}
	}
	return tokens;
}

/**
 * Splits pretty-printed JSON into lines of typed tokens for highlighting. Joining every token's
 * text (lines separated by a newline) gives the input back exactly.
 */
export function tokenizeJsonLines(text: string): JsonToken[][] {
	return text.split("\n").map(tokenizeLine);
}
