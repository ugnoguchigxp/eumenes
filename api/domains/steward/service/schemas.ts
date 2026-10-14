/**
 * Output schemas of the steps. They are written for strict `json_schema` response formats: every key is
 * required, objects take no other keys, and a value that may be absent is `null`. The host normalizes element
 * by element (`null` means "none"), so a schema the provider cannot enforce still gets a usable answer.
 */
import { relationKinds } from "eumenes-world-model";

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

/**
 * The answer of curate-memory. `resolve.request` is one of the request labels this unit gave (`r1`...): the model can
 * not name another request. A unit without requests allows only the empty label, which the host drops (a strict
 * enum can not be empty).
 */
export const curateSchema = (requestLabels: readonly string[]) =>
	obj({
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
		update: list(
			obj({ ref: str, text: str, evidence: str, quote: nullableStr }),
		),
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
				request: enumOf(requestLabels.length > 0 ? requestLabels : [""]),
				action: enumOf(["forget", "stop", "remember", "update", "none"]),
				refs: strings,
				alsoIn: strings,
				text: nullableStr,
				kind: nullableEnum(stateKinds),
				key: nullableStr,
			}),
		),
		route: list(obj({ exchange: str, world: bool, goals: bool })),
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

const priorities = ["high", "normal", "low"];
const worldValue = obj({
	type: enumOf(["string", "boolean", "number"]),
	text: nullableStr,
	flag: { type: ["boolean", "null"] },
	number: { type: ["number", "null"] },
	unit: nullableStr,
});
export const curateWorldSchema = obj({
	entities: list(obj({ name: str, aliases: strings })),
	claims: list(
		obj({
			op: enumOf(["assert", "correct", "retract"]),
			ref: nullableStr,
			subject: nullableStr,
			predicate: nullableStr,
			value: { anyOf: [worldValue, { type: "null" }] },
			relation: {
				anyOf: [
					obj({ kind: enumOf(relationKinds), object: str }),
					{ type: "null" },
				],
			},
			evidence: str,
			origin: enumOf(["user_report", "model_hypothesis"]),
			validFrom: nullableStr,
			validUntil: nullableStr,
		}),
	),
	changed: bool,
});

export const curateGoalsSchema = obj({
	goals: list(
		obj({
			op: enumOf(["propose", "adopt", "revise", "complete", "withdraw"]),
			ref: nullableStr,
			text: nullableStr,
			priority: nullableEnum(priorities),
			evidence: str,
			entities: strings,
			request: nullableStr,
		}),
	),
});

export const consolidateGoalsSchema = obj({
	withdraw: list(
		obj({ ref: str, why: enumOf(["duplicate", "stale", "low_relevance"]) }),
	),
	changed: bool,
});
