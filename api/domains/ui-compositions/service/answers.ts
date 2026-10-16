import type { Database } from "bun:sqlite";
import { fail, formFields, submitInput } from "../contracts";
import { get, saveReceipt } from "../repository";
import {
	replayOf,
	requireUi,
	scope,
	digestOf,
	type Caller,
	type Outcome,
} from "./shared";

// --- answers to a saved composition's form ---
export function submitInTransaction(
	db: Database,
	caller: Caller,
	input: { projectId: string; expectedGeneration: number; values: unknown },
	requestId: string,
): Outcome & { responseId: string } {
	const digest = digestOf("submit", input);
	const replay = replayOf(db, requestId, digest);
	if (replay)
		return { ...replay, responseId: replay.receipt.responseId ?? requestId };
	requireUi(caller);
	const row = get(db, input.projectId);
	if (!row || row.scope !== scope || !row.fields_json)
		return fail("ui_project_not_ready");
	if (row.saved_revision !== input.expectedGeneration)
		return fail("ui_project_changed");
	const values = { ...submitInput.parse(input.values) };
	const fields = formFields.parse(JSON.parse(row.fields_json));
	for (const field of fields)
		if (field.type === "checkbox" && typeof values[field.id] === "string") {
			try {
				values[field.id] = JSON.parse(values[field.id] as string);
			} catch {
				return fail("ui_response_invalid");
			}
		}
	const allowed = new Set(fields.map((f) => f.id));
	if (Object.keys(values).some((key) => !allowed.has(key)))
		return fail("ui_response_unknown_field");
	for (const field of fields) {
		const value = values[field.id];
		if (
			field.required &&
			(value === undefined ||
				value === "" ||
				(Array.isArray(value) && value.length === 0) ||
				value === false)
		)
			return fail("ui_response_required");
		if (value === undefined) continue;
		if (
			field.type === "checkbox"
				? !Array.isArray(value) ||
					value.some((v) => !field.options?.includes(v))
				: field.type === "boolean"
					? typeof value !== "boolean"
					: typeof value !== "string" ||
						value.length > 2000 ||
						(["select", "radio"].includes(field.type) &&
							!field.options?.includes(value))
		)
			return fail("ui_response_invalid");
	}
	db.query(
		"INSERT INTO ui_composition_responses(id,composition_id,generation,values_json,created_at) VALUES(?,?,?,?,?)",
	).run(
		requestId,
		row.id,
		row.saved_revision,
		JSON.stringify(values),
		Date.now(),
	);
	saveReceipt(
		db,
		requestId,
		{ projectId: row.id, state: "submitted", responseId: requestId },
		digest,
	);
	return {
		receipt: { projectId: row.id, state: "submitted", responseId: requestId },
		replay: false,
		responseId: requestId,
	};
}
