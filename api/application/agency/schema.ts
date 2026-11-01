import { mapJsonSchema } from "../../infrastructure/json-schema";

/** Share identical nullable schemas instead of repeatedly expanding the provider grammar.
 * The F live comparison reproduced a provider rejection without this factoring.
 * Only the transport representation changes; the original Zod schema validates the receipt.
 */
export function shareNullableSchemas(schema: Record<string, unknown>) {
	const oldDefs = (schema.$defs ?? {}) as Record<string, unknown>;
	const definitions: Record<string, unknown> = {};
	const seen = new Map<string, string>();
	let counter = 0;
	const rewritten = mapJsonSchema(schema, (node) => {
		if (
			!Array.isArray(node.anyOf) ||
			!node.anyOf.some((choice) => choice?.type === "null")
		)
			return node;
		const key = JSON.stringify(node);
		let name = seen.get(key);
		if (!name) {
			do {
				name = `agencyNullable${counter++}`;
			} while (name in oldDefs);
			seen.set(key, name);
			definitions[name] = node;
		}
		return { $ref: `#/$defs/${name}` };
	}) as Record<string, unknown>;
	return Object.keys(definitions).length
		? {
				...rewritten,
				$defs: { ...(rewritten.$defs as object), ...definitions },
			}
		: rewritten;
}
