/**
 * Output schemas of the steps. They are written for strict `json_schema` response formats: every key is
 * required, objects take no other keys, and a value that may be absent is `null`. The host normalizes element
 * by element (`null` means "none"), so a schema the provider cannot enforce still gets a usable answer.
 */
type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const nullableStr: Schema = { type: ["string", "null"] };
const bool: Schema = { type: "boolean" };
const strings: Schema = { type: "array", items: str };
const enumOf = (values: readonly string[]): Schema => ({
	type: "string",
	enum: values,
});
const nullableEnum = (values: readonly string[]): Schema => ({
	type: ["string", "null"],
	enum: [...values, null],
});
function obj(properties: Record<string, Schema>): Schema {
	return {
		type: "object",
		additionalProperties: false,
		required: Object.keys(properties),
		properties,
	};
}
const list = (items: Schema): Schema => ({ type: "array", items });

const stateKinds = ["preference", "personal_fact", "constraint", "habit"];
const noteKinds = ["goal", "decision", "open_question", "activity", "memo"];

export const curateSchema = obj({
	remember: list(
		obj({
			kind: enumOf(stateKinds),
			key: str,
			text: str,
			evidence: str,
			quote: nullableStr,
			validFrom: nullableStr,
			validUntil: nullableStr,
			negated: bool,
		}),
	),
	update: list(obj({ ref: str, text: str, evidence: str, quote: nullableStr })),
	stop: list(
		obj({
			ref: str,
			why: enumOf(["contradicted", "outdated", "wrong", "user_asked"]),
		}),
	),
	notes: list(
		obj({
			op: enumOf(["add", "update", "close"]),
			ref: nullableStr,
			kind: nullableEnum(noteKinds),
			text: nullableStr,
			status: nullableEnum(["resolved", "retracted"]),
		}),
	),
	resolve: list(
		obj({
			request: str,
			action: enumOf(["forget", "stop", "remember", "update", "none"]),
			refs: strings,
			alsoIn: strings,
			text: nullableStr,
			kind: nullableEnum(stateKinds),
			key: nullableStr,
		}),
	),
});

export const disposeSchema = obj({
	exchanges: list(
		obj({
			id: str,
			action: enumOf(["keep", "summarize", "drop"]),
			duplicateOf: nullableStr,
		}),
	),
});

export const summarizeSchema = obj({ summary: str, included: strings });

export const recallSchema = obj({ query: nullableStr });

export const consolidateSchema = obj({
	merge: list(obj({ refs: strings, key: nullableStr, text: str })),
	stop: list(
		obj({ ref: str, why: enumOf(["outdated", "duplicate", "wrong"]) }),
	),
	tendencies: list(
		obj({
			op: enumOf(["add", "update", "retire"]),
			ref: nullableStr,
			text: nullableStr,
			evidenceRefs: strings,
		}),
	),
	republishLongTerm: bool,
	changed: bool,
});

export const compactSchema = obj({
	fold: strings,
	summary: str,
	changed: bool,
});

export const refineSchema = obj({ summary: str, changed: bool });
