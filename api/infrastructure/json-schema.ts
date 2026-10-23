/** Transform schemas, traversing schema-valued keywords only. enum/const/default/examples remain literal data. */
export function mapJsonSchema(
	value: unknown,
	transform: (schema: Record<string, unknown>) => Record<string, unknown>,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result = { ...(value as Record<string, unknown>) };
	for (const key of [
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
	]) {
		const entries = result[key];
		if (entries && typeof entries === "object" && !Array.isArray(entries))
			result[key] = Object.fromEntries(
				Object.entries(entries).map(([name, schema]) => [
					name,
					mapJsonSchema(schema, transform),
				]),
			);
	}
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
		if (Array.isArray(result[key]))
			result[key] = result[key].map((schema) =>
				mapJsonSchema(schema, transform),
			);
	for (const key of [
		"items",
		"additionalProperties",
		"additionalItems",
		"contains",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
		"unevaluatedProperties",
		"unevaluatedItems",
		"contentSchema",
	])
		if (key in result) result[key] = mapJsonSchema(result[key], transform);
	return transform(result);
}
