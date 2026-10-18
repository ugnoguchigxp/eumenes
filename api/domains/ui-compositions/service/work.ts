import type { Database } from "bun:sqlite";
import {
	canonicalText,
	checkDefinitionText,
	fail,
	fieldsOfDefinition,
	limits,
	type Definition,
} from "../contracts";
import {
	bumpRevision,
	deleteComposition,
	deleteWork,
	dropSnapshotsAfter,
	get,
	insertComposition,
	insertWork,
	putSnapshot,
	snapshot,
	updateComposition,
	updateWork,
	work,
	worksOfComposition,
	type WorkRow,
} from "../repository";
import {
	accept,
	digestOf,
	editableDefinition,
	loadWork,
	parseJson,
	replayOf,
	requireUi,
	scope,
	stateOf,
	type Caller,
	type Outcome,
	type RejectedDraft,
	type WorkState,
} from "./shared";

// --- the work of a specialist session (SessionWorkAdapter semantics) ---
export function openWorkInTransaction(
	db: Database,
	input: { sessionId: string; targetRef: string | null },
): WorkState {
	const existing = db
		.query("SELECT * FROM ui_composition_works WHERE session_id=?")
		.get(input.sessionId) as WorkRow | null;
	if (existing) return stateOf(db, existing);
	const saved = input.targetRef ? get(db, input.targetRef) : null;
	if (input.targetRef && saved?.scope !== scope) fail("target_not_found");
	const id = crypto.randomUUID();
	const definition = saved ? editableDefinition(saved) : null;
	insertWork(db, {
		id,
		scope,
		session_id: input.sessionId,
		composition_id: saved?.id ?? null,
		base_saved_revision: saved?.saved_revision ?? 0,
		updated_at: Date.now(),
	});
	putSnapshot(
		db,
		id,
		0,
		saved?.title ?? "",
		definition ? JSON.stringify(definition) : null,
	);
	bumpRevision(db, scope);
	return stateOf(db, work(db, id)!);
}
export function workStateInTransaction(db: Database, workRef: string) {
	const row = work(db, workRef);
	return row ? stateOf(db, row) : null;
}
export function beginTurnInTransaction(
	db: Database,
	workRef: string,
	runId: string,
) {
	const row = loadWork(db, workRef);
	if (row.busy_run_id === runId) return;
	if (row.busy_run_id !== null) fail("work_busy");
	updateWork(db, row.id, { busy_run_id: runId }, Date.now());
	bumpRevision(db, scope);
}
export function endTurnInTransaction(
	db: Database,
	workRef: string,
	runId: string,
) {
	const row = work(db, workRef);
	if (!row || row.busy_run_id !== runId) return;
	updateWork(db, row.id, { busy_run_id: null }, Date.now());
	bumpRevision(db, scope);
}
export function endWorkInTransaction(
	db: Database,
	workRef: string,
	mode: "discard" | "close",
) {
	const row = work(db, workRef);
	if (!row) return;
	if (mode === "close" && row.cursor > 0) fail("work_unsaved");
	deleteWork(db, row.id);
	bumpRevision(db, scope);
}

// --- the work document (spec subagent-task-and-session-agents §7.2) ---
/** The rejected draft is kept within this size; a longer text is cut (its issues stay whole). */
const REJECTED_TEXT_BYTES = 64 * 1024;

/** The work's current revision as its canonical text, with the rejected draft kept since. */
export function documentInTransaction(db: Database, workRef: string) {
	const row = work(db, workRef);
	if (!row) return null;
	const current = snapshot(db, row.id, row.cursor)!;
	const definition = parseJson<Definition>(current.definition_json);
	return {
		revision: row.draft_revision,
		title: current.title,
		text: definition ? canonicalText(definition) : "",
		rejected: parseJson<RejectedDraft>(row.rejected_json),
	};
}

/**
 * A checked definition as the work's next revision: from the specialist turn that holds the work, or from the
 * screen while no turn does. `no_change` when it is the current one, `revision_conflict` on another revision.
 * Clears the rejected draft.
 */
export function commitDocumentInTransaction(
	db: Database,
	caller: Caller,
	workRef: string,
	input: { baseRevision: number; title?: string; definition: Definition },
): { revision: number } {
	const row = loadWork(db, workRef);
	if (caller.kind === "specialist") {
		if (caller.workRef !== row.id || row.busy_run_id !== caller.runId)
			return fail("turn_not_current");
	} else if (row.busy_run_id !== null) return fail("generation_in_progress");
	if (row.draft_revision !== input.baseRevision)
		return fail("revision_conflict");
	const current = snapshot(db, row.id, row.cursor)!;
	const title = input.title ?? current.title;
	const json = JSON.stringify(input.definition);
	if (current.title === title && current.definition_json === json)
		return fail("no_change");
	const next = row.cursor + 1;
	if (next > limits.changes) return fail("undo_limit_reached");
	dropSnapshotsAfter(db, row.id, row.cursor);
	putSnapshot(db, row.id, next, title, json);
	updateWork(
		db,
		row.id,
		{
			cursor: next,
			snapshot_count: next + 1,
			draft_revision: row.draft_revision + 1,
			rejected_json: null,
		},
		Date.now(),
	);
	bumpRevision(db, scope);
	return { revision: row.draft_revision + 1 };
}

/** Keep a whole draft that failed its check (replaces the one kept before); the shown revision stays. */
export function rejectDocumentInTransaction(
	db: Database,
	workRef: string,
	draft: Omit<RejectedDraft, "createdAt">,
) {
	const row = loadWork(db, workRef);
	const bytes = Buffer.from(draft.text);
	const text =
		bytes.length > REJECTED_TEXT_BYTES
			? `${bytes.subarray(0, REJECTED_TEXT_BYTES).toString("utf8")}…`
			: draft.text;
	const rejected: RejectedDraft = {
		...draft,
		text,
		createdAt: new Date().toISOString(),
	};
	updateWork(db, row.id, { rejected_json: JSON.stringify(rejected) }, Date.now());
	bumpRevision(db, scope);
}

/**
 * The user's own edit of the source on the screen (spec §7.7): the same check as the specialist's text, then
 * the work's next revision. A refusal names the first issue's position and rule for the screen to show.
 */
export function applySourceInTransaction(
	db: Database,
	caller: Caller,
	input: { workRef: string; expectedRevision: number; text: string },
	requestId: string,
): Outcome {
	const digest = digestOf("source.apply", input);
	const replay = replayOf(db, requestId, digest);
	if (replay) return replay;
	requireUi(caller);
	const checked = checkDefinitionText(input.text);
	if (!checked.ok) {
		const issue = checked.issues[0];
		return fail(checked.code, issue ? `${issue.path}: ${issue.rule}` : undefined);
	}
	const { revision } = commitDocumentInTransaction(db, caller, input.workRef, {
		baseRevision: input.expectedRevision,
		definition: checked.definition,
	});
	const row = loadWork(db, input.workRef);
	return accept(db, requestId, digest, {
		projectId: row.id,
		state: "drafted",
		workRef: row.id,
		revision,
		title: snapshot(db, row.id, row.cursor)!.title,
	});
}
export function stepInTransaction(
	db: Database,
	direction: "undo" | "redo",
	caller: Caller,
	input: { workRef: string; expectedRevision: number },
	requestId: string,
): Outcome {
	const digest = digestOf(direction, input);
	const replay = replayOf(db, requestId, digest);
	if (replay) return replay;
	requireUi(caller);
	const row = loadWork(db, input.workRef);
	if (row.busy_run_id !== null) return fail("generation_in_progress");
	if (row.draft_revision !== input.expectedRevision)
		return fail("revision_conflict");
	if (direction === "undo" && row.cursor === 0) return fail("nothing_to_undo");
	if (direction === "redo" && row.cursor >= row.snapshot_count - 1)
		return fail("nothing_to_redo");
	const cursor = row.cursor + (direction === "undo" ? -1 : 1);
	updateWork(
		db,
		row.id,
		{ cursor, draft_revision: row.draft_revision + 1 },
		Date.now(),
	);
	return accept(db, requestId, digest, {
		projectId: row.id,
		state: direction === "undo" ? "undone" : "redone",
		workRef: row.id,
		revision: row.draft_revision + 1,
		title: snapshot(db, row.id, cursor)!.title,
	});
}
export function saveInTransaction(
	db: Database,
	caller: Caller,
	input: {
		workRef: string;
		expectedRevision: number;
		expectedSavedRevision: number;
	},
	requestId: string,
): Outcome {
	const digest = digestOf("save", input);
	const replay = replayOf(db, requestId, digest);
	if (replay) return replay;
	requireUi(caller);
	const row = loadWork(db, input.workRef);
	if (row.busy_run_id !== null) return fail("generation_in_progress");
	if (row.draft_revision !== input.expectedRevision)
		return fail("revision_conflict");
	const saved = row.composition_id ? get(db, row.composition_id) : null;
	if (row.composition_id && !saved) return fail("save_conflict");
	const savedRevision = saved?.saved_revision ?? 0;
	if (
		input.expectedSavedRevision !== savedRevision ||
		row.base_saved_revision !== savedRevision
	)
		return fail("save_conflict");
	if (row.cursor === 0) return fail("nothing_to_save");
	const current = snapshot(db, row.id, row.cursor)!;
	const definition = parseJson<Definition>(current.definition_json);
	if (!definition) return fail("nothing_to_save");
	const now = Date.now();
	const fields = fieldsOfDefinition(definition);
	const content = {
		title: current.title,
		definition_json: current.definition_json,
		fields_json: fields ? JSON.stringify(fields) : null,
	};
	const id = saved?.id ?? crypto.randomUUID();
	if (saved) updateComposition(db, { id, ...content, updated_at: now });
	else insertComposition(db, { id, scope, ...content, created_at: now });
	// The undo history collapses to the one confirmed state.
	dropSnapshotsAfter(db, row.id, -1);
	putSnapshot(db, row.id, 0, current.title, current.definition_json);
	const nextSaved = savedRevision + 1;
	updateWork(
		db,
		row.id,
		{
			composition_id: id,
			base_saved_revision: nextSaved,
			cursor: 0,
			snapshot_count: 1,
			draft_revision: row.draft_revision + 1,
			rejected_json: null,
		},
		now,
	);
	return accept(db, requestId, digest, {
		projectId: id,
		state: "saved",
		workRef: row.id,
		revision: row.draft_revision + 1,
		savedRevision: nextSaved,
		title: current.title,
	});
}
/** Deleting a saved composition from the screen; a work still built on it keeps it. */
export function deleteInTransaction(
	db: Database,
	caller: Caller,
	input: { projectId: string; expectedSavedRevision: number },
	requestId: string,
): Outcome {
	const digest = digestOf("delete", input);
	const replay = replayOf(db, requestId, digest);
	if (replay) return replay;
	requireUi(caller);
	const saved = get(db, input.projectId);
	if (!saved || saved.scope !== scope) return fail("target_not_found");
	if (saved.saved_revision !== input.expectedSavedRevision)
		return fail("revision_conflict");
	if (worksOfComposition(db, saved.id) > 0) return fail("composition_in_use");
	deleteComposition(db, saved.id);
	return accept(db, requestId, digest, {
		projectId: saved.id,
		state: "deleted",
		savedRevision: saved.saved_revision,
		title: saved.title,
	});
}
