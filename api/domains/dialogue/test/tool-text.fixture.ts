/**
 * A tool result as the model reads it (`- key: value` lines, the conversation input specification, section 9),
 * read back into fields for a test's checks: `true`/`false` and numbers become values, the rest stays text.
 */
export function toolFields(text: string): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const line of text.split("\n")) {
		const match = /^- ([^:]+): (.*)$/.exec(line);
		if (!match) continue;
		const value = match[2]!;
		fields[match[1]!] =
			value === "true"
				? true
				: value === "false"
					? false
					: /^-?\d+(\.\d+)?$/.test(value)
						? Number(value)
						: value;
	}
	return fields;
}
