import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { fail, inlineForm, type Definition } from "../contracts";
import {
	bumpRevision,
	receipt,
	saveReceipt,
	snapshot,
	work,
	type CompositionRow,
	type StoredReceipt,
	type WorkRow,
} from "../repository";

export const scope = "default";
/** Who asks: the screen (the user's own action) or a specialist turn holding the work. */
export type Caller =
	| { kind: "ui" }
	| { kind: "specialist"; runId: string; workRef: string };
export type Outcome = { receipt: StoredReceipt; replay: boolean };
/** The work as the dialogue sees it (host data, never model text). */
export type WorkState = {
	workRef: string;
	savedRef: string | null;
	dirty: boolean;
	busy: boolean;
	revision: number;
	label: string;
	current: { title: string; definition: Definition | null };
};

export const parseJson = <T>(json: string | null): T | null =>
	json === null ? null : (JSON.parse(json) as T);
export const digestOf = (operation: string, input: unknown) =>
	sha256Hex(`${operation}\n${JSON.stringify(input)}`);

/** Saved definitions keep the form inline; legacy rows kept the fields beside a form source. */
export function editableDefinition(row: CompositionRow): Definition | null {
	const definition = parseJson<Definition>(row.definition_json);
	return definition ? inlineForm(definition, parseJson(row.fields_json)) : null;
}
export function summary(row: CompositionRow) {
	return {
		id: row.id,
		title: row.title,
		savedRevision: row.saved_revision,
		updatedAt: row.updated_at,
	};
}
export function loadWork(db: Database, workRef: string): WorkRow {
	return work(db, workRef) ?? fail("work_not_found");
}
export function stateOf(db: Database, row: WorkRow): WorkState {
	const current = snapshot(db, row.id, row.cursor)!;
	return {
		workRef: row.id,
		savedRef: row.composition_id,
		dirty: row.cursor > 0,
		busy: row.busy_run_id !== null,
		revision: row.draft_revision,
		label: current.title || "新しいUI",
		current: {
			title: current.title,
			definition: parseJson<Definition>(current.definition_json),
		},
	};
}
/** An earlier outcome of the same request; the same id with other input is refused. */
export function replayOf(
	db: Database,
	requestId: string,
	digest: string,
): Outcome | null {
	const saved = receipt(db, requestId);
	if (!saved) return null;
	// Receipts written before digests existed carry none and replay as before.
	if (saved.digest !== null && saved.digest !== digest)
		return fail("request_conflict");
	return { receipt: saved.receipt, replay: true };
}
export function accept(
	db: Database,
	requestId: string,
	digest: string,
	value: StoredReceipt,
): Outcome {
	saveReceipt(db, requestId, value, digest);
	bumpRevision(db, scope);
	return { receipt: value, replay: false };
}
export function requireUi(caller: Caller) {
	if (caller.kind !== "ui") fail("origin_not_allowed");
}
