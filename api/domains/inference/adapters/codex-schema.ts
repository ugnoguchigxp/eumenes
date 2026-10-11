// Codex Structured Outputs accepts a root object and nested anyOf. The host's
// discriminated oneOf branches remain authoritative at result validation.
function wireSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(wireSchema);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key === "oneOf" ? "anyOf" : key,
				key === "properties" || key === "$defs"
					? Object.fromEntries(
							Object.entries(child as Record<string, unknown>).map(
								([name, schema]) => [name, wireSchema(schema)],
							),
						)
					: [
								"oneOf",
								"anyOf",
								"allOf",
								"items",
								"additionalProperties",
								"not",
						  ].includes(key)
						? wireSchema(child)
						: child,
			]),
		);
	return value;
}
/** The host's output schema arrives as a value; it is never re-read from prompt text. */
export function codexStructuredControl(output: unknown) {
	if (!output || typeof output !== "object" || Array.isArray(output))
		throw new Error("codex_research_schema_missing");
	return {
		schema: {
			type: "object",
			properties: { decision: wireSchema(output) },
			required: ["decision"],
			additionalProperties: false,
		},
		decode(text: string) {
			let envelope;
			try {
				envelope = JSON.parse(text);
			} catch {
				throw new Error("codex_research_invalid_output");
			}
			if (
				!envelope ||
				typeof envelope !== "object" ||
				Object.keys(envelope).length !== 1 ||
				!envelope.decision ||
				typeof envelope.decision !== "object" ||
				Array.isArray(envelope.decision)
			)
				throw new Error("codex_research_invalid_output");
			return JSON.stringify(envelope.decision);
		},
	};
}
