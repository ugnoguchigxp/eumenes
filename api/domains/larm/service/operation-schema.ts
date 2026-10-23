import { mapJsonSchema } from "../../../infrastructure/json-schema";

/**
 * The deployed grammar compiler fails on large string-length ranges (a 2,000-character search contract returns
 * HTTP 500). Keep those bounds in the source/host validator and describe them here without expanding a bounded
 * string grammar. Types, choices, required fields and object boundaries remain grammar constraints.
 * This is a single request projection, never a retry or a change of the source operation contract.
 */
export function operationSchema(value: unknown): unknown {
	return mapJsonSchema(value, (source) => {
		const result = { ...source };
		if (
			source.type === "string" &&
			(source.minLength !== undefined || source.maxLength !== undefined)
		) {
			delete result.minLength;
			delete result.maxLength;
			result.description = [
				source.description,
				`文字列の長さ制約（hostも検証）: minLength=${source.minLength ?? 0}, maxLength=${source.maxLength ?? "制限なし"}。`,
			]
				.filter(Boolean)
				.join("\n");
		}
		return result;
	});
}
