import type { z } from "zod";
import type { LogFields } from "./logger";

// Paths come from contracts. Unknown keys, enum values and Zod messages may
// contain provider text or secrets, so none of them are copied into logs.
const fields = new Set([
	"action",
	"tool",
	"intent",
	"terms",
	"question",
	"candidateRef",
	"input",
	"executionRef",
	"arguments",
	"report",
	"summary",
	"claims",
	"text",
	"evidence",
	"sourceId",
	"viewId",
	"sourceRef",
	"cursor",
	"messageRef",
	"version",
	"outcome",
	"exploration",
	"needs",
	"id",
	"item",
	"requestQuote",
	"status",
	"from",
	"until",
	"speaker",
	"limit",
	"before",
	"after",
	"characters",
	"excerptId",
	"quote",
	"limitations",
	"facts",
	"urls",
	"detail",
	"query",
	"language",
	"region",
	"timeRange",
	"url",
	"areaCode",
	"symbol",
	"command",
	"operation",
	"durationSeconds",
	"label",
	"timerId",
	"expectedRevision",
	"state",
	"requirements",
	"statement",
	"valueSchema",
	"checks",
	"requirementId",
	"externalRules",
	"value",
	"reason",
	"requestCovered",
	"summarySupported",
	"limitationsConsistent",
	"supported",
	"index",
]);
const types = new Set([
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"null",
	"undefined",
	"bigint",
	"symbol",
	"function",
	"enum",
	"unknown",
]);
export function valueType(value: unknown): string {
	return value === null
		? "null"
		: Array.isArray(value)
			? "array"
			: typeof value;
}
function pathLabel(path: PropertyKey[]): string {
	// JSON values and schemas may contain arbitrary user-defined property names.
	const dynamic = path.findIndex(
		(key) => key === "value" || key === "valueSchema",
	);
	if (dynamic >= 0) path = path.slice(0, dynamic + 1);
	return (
		path
			.slice(0, 12)
			.map((key) =>
				typeof key === "number" && Number.isSafeInteger(key) && key >= 0
					? String(key)
					: typeof key === "string" && fields.has(key)
						? key
						: "unknown",
			)
			.join(".") || "$"
	);
}
function atPath(value: unknown, path: PropertyKey[]): unknown {
	for (const key of path) {
		if (
			value === null ||
			typeof value !== "object" ||
			!Object.hasOwn(value, key)
		)
			return undefined;
		value = (value as Record<PropertyKey, unknown>)[key];
	}
	return value;
}
export function validationIssues(
	error: z.ZodError,
	value: unknown,
	prefix: string[] = [],
): LogFields[] {
	return error.issues.slice(0, 8).map((issue) => ({
		validationPath: pathLabel([...prefix, ...issue.path]),
		validationCode: issue.code,
		actualType: valueType(atPath(value, issue.path)),
		...("expected" in issue &&
		typeof issue.expected === "string" &&
		types.has(issue.expected)
			? { expectedType: issue.expected }
			: {}),
		...(issue.code === "invalid_value" || issue.code === "invalid_union"
			? { expectedType: "enum_or_union" }
			: {}),
		...(issue.code === "too_big" && typeof issue.maximum === "number"
			? { limit: issue.maximum }
			: {}),
		...(issue.code === "too_small" && typeof issue.minimum === "number"
			? { limit: issue.minimum }
			: {}),
	}));
}
/** Carries only sanitized diagnostics; preserves the existing runtime error code. */
export class ValidationFailure extends Error {
	constructor(
		code: string,
		public readonly issues: LogFields[],
		public readonly issueCount = issues.length,
	) {
		super(code);
	}
}
