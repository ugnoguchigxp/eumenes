/**
 * Incremental ECMA-48 filtering: escape strings may cross PTY chunks or be arbitrarily long.
 * Keep only plain text, so truncation cannot split an escape sequence or count its bytes.
 */
export function createOutput() {
	const decoder = new TextDecoder();
	let head = "",
		tail = "",
		length = 0;
	let mode: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
	const add = (text: string) => {
		let plain = "";
		for (const c of text) {
			const n = c.charCodeAt(0);
			if (mode === "string-escape") {
				mode = c === "\\" ? "text" : c === "\x1b" ? "string-escape" : "string";
				continue;
			}
			if (mode === "string") {
				if (c === "\x07" || c === "\x9c") mode = "text";
				else if (c === "\x1b") mode = "string-escape";
				continue;
			}
			if (mode === "csi") {
				if (n >= 0x40 && n <= 0x7e) mode = "text";
				else if (c === "\x1b") mode = "escape";
				continue;
			}
			if (mode === "escape") {
				if (c === "[") mode = "csi";
				else if ("]PX^_".includes(c)) mode = "string";
				else if (n < 0x20 || n > 0x2f) mode = "text";
				continue;
			}
			if (c === "\x1b") mode = "escape";
			else if (c === "\x9b") mode = "csi";
			else if (["\x90", "\x9d", "\x98", "\x9e", "\x9f"].includes(c))
				mode = "string";
			else if (c !== "\r") plain += c;
		}
		length += plain.length;
		head = (head + plain).slice(0, 30_000);
		tail = (tail + plain).slice(-30_000);
	};
	const headPart = (s: string, n: number) => {
		const p = s.slice(0, n);
		return /[\uD800-\uDBFF]$/.test(p) ? p.slice(0, -1) : p;
	};
	const tailPart = (s: string, n: number) => {
		const p = s.slice(-n);
		return /^[\uDC00-\uDFFF]/.test(p) ? p.slice(1) : p;
	};
	return {
		add: (bytes: Uint8Array) => add(decoder.decode(bytes, { stream: true })),
		finish() {
			add(decoder.decode());
		},
		result() {
			const truncated = length > 30_000;
			const first = headPart(head, truncated ? 14_960 : 30_000),
				last = tailPart(tail, 14_960);
			return {
				output: truncated
					? first +
						`\n（${length - first.length - last.length}字省略）\n` +
						last
					: first,
				outputTruncated: truncated,
			};
		},
	};
}
