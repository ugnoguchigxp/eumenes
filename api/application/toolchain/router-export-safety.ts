/** Security filtering only; never used to classify or route an utterance. */
export function exportRedactor(values: readonly string[]) {
	const literals = [...new Set(values.filter(Boolean))].sort(
		(a, b) => b.length - a.length,
	);
	let count = 0;
	function text(input: string) {
		let output = input;
		for (const value of literals)
			output = output.split(value).join("[REDACTED]");
		output = output
			.replace(
				/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
				"[REDACTED]",
			)
			.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[REDACTED]")
			.replace(
				/((?:EUMENES_[A-Z0-9_]+|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
				"$1[REDACTED]",
			)
			.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
				try {
					const parsed = new URL(url);
					return parsed.username ||
						parsed.password ||
						[...parsed.searchParams.keys()].some((key) =>
							/token|secret|password|key|credential/i.test(key),
						)
						? "[REDACTED]"
						: url;
				} catch {
					return "[REDACTED]";
				}
			});
		if (output !== input) count++;
		return output;
	}
	function scrub(value: unknown): unknown {
		if (typeof value === "string") return text(value);
		if (Array.isArray(value)) return value.map(scrub);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, scrub(item)]),
			);
		return value;
	}
	return { scrub, count: () => count };
}
