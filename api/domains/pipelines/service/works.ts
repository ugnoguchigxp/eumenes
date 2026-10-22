import type { Database } from "bun:sqlite";
import { hash, type PipelineDefinition } from "../../capabilities";
import {
	bumpStudioRevision,
	deleteWork,
	insertWork,
	putVersion,
	receipt,
	saveReceipt,
	updateWork,
	work,
	workOfSession,
	type WorkRow,
} from "../repository";
import { canonicalText, checkText, type DocumentIssue } from "./document";

/**
 * The studio's work of one specialist session (spec task-pipeline-design 2026-10-22 §8.1, §13.6; the session work
 * contract of subagent-task-and-session-agents §5): the draft the agent and the screen edit, revision by revision.
 * Publishing is the application's (it registers a toolchain); the work only records what was published.
 */

/** A refusal carrying only a safe, lowercase code; `detail` is a short note for repair ("pointer: rule"), never data. */
export class PipelineError extends Error {
	constructor(
		readonly code: string,
		readonly detail?: string,
	) {
		super(code);
	}
}
const fail = (code: string, detail?: string): never => {
	throw new PipelineError(code, detail);
};

export type Caller =
	| { kind: "ui" }
	| { kind: "specialist"; runId: string; workRef: string };
export type RejectedDraft = {
	title: string;
	text: string;
	issues: DocumentIssue[];
	fixes: string[];
	createdAt: string;
};
export type WorkReceipt = {
	workRef: string;
	/** `rejected`: the text did not pass the format check and is kept as the rejected draft to show its issues. */
	state: "drafted" | "rejected" | "published";
	revision: number;
	toolchainId?: string;
};

/** The rejected draft is kept within this size; a longer text is cut (its issues stay whole). */
const REJECTED_TEXT_CHARS = 32_768;

const loadWork = (db: Database, workRef: string) =>
	work(db, workRef) ?? fail("work_not_found");
const dirtyOf = (row: WorkRow) =>
	row.published_digest === null
		? row.text !== ""
		: row.published_digest !== hash(row.text);
const parse = <T>(text: string | null) =>
	text ? (JSON.parse(text) as T) : null;

function stateOf(row: WorkRow) {
	return {
		workRef: row.id,
		savedRef: row.target_id,
		dirty: dirtyOf(row),
		busy: row.busy_run_id !== null,
		revision: row.revision,
		label: row.title || "新しいパイプライン",
		current: { title: row.title, text: row.text },
	};
}
export type WorkState = ReturnType<typeof stateOf>;

/** A new session's work: empty, or the published definition it opens (then not dirty until changed). */
export function openWorkInTransaction(
	db: Database,
	input: {
		sessionId: string;
		target: { toolchainId: string; definition: PipelineDefinition } | null;
	},
): WorkState {
	const existing = workOfSession(db, input.sessionId);
	if (existing) return stateOf(existing);
	const text = input.target ? canonicalText(input.target.definition) : "";
	const row: WorkRow = {
		id: crypto.randomUUID(),
		session_id: input.sessionId,
		target_id: input.target?.toolchainId ?? null,
		revision: 0,
		title: input.target?.definition.title ?? "",
		text,
		previous_text: "",
		published_digest: input.target ? hash(text) : null,
		busy_run_id: null,
		rejected_json: null,
		updated_at: Date.now(),
	};
	insertWork(db, row);
	putVersion(db, {
		workId: row.id,
		revision: 0,
		title: row.title,
		text,
		origin: input.target ? "open" : "create",
	});
	bumpStudioRevision(db);
	return stateOf(row);
}
export function workStateInTransaction(db: Database, workRef: string) {
	const row = work(db, workRef);
	return row ? stateOf(row) : null;
}
export function sessionOfWorkInTransaction(db: Database, workRef: string) {
	return work(db, workRef)?.session_id ?? null;
}
export function beginTurnInTransaction(
	db: Database,
	workRef: string,
	runId: string,
) {
	const row = loadWork(db, workRef);
	if (row.busy_run_id === runId) return;
	if (row.busy_run_id !== null) fail("work_busy");
	updateWork(db, row.id, { busy_run_id: runId });
	bumpStudioRevision(db);
}
export function endTurnInTransaction(
	db: Database,
	workRef: string,
	runId: string,
) {
	const row = work(db, workRef);
	if (!row || row.busy_run_id !== runId) return;
	updateWork(db, row.id, { busy_run_id: null });
	bumpStudioRevision(db);
}
/** `close` keeps nothing unpublished: a changed draft must be published or discarded first. */
export function endWorkInTransaction(
	db: Database,
	workRef: string,
	mode: "discard" | "close",
) {
	const row = work(db, workRef);
	if (!row) return;
	if (mode === "close" && dirtyOf(row)) fail("work_unsaved");
	deleteWork(db, row.id);
	bumpStudioRevision(db);
}

export function documentInTransaction(db: Database, workRef: string) {
	const row = work(db, workRef);
	if (!row) return null;
	return {
		revision: row.revision,
		title: row.title,
		text: row.text,
		previousText: row.previous_text,
		rejected: parse<RejectedDraft>(row.rejected_json),
	};
}

/**
 * A checked definition as the work's next revision: from the turn that holds the work, or from the screen while no
 * turn does. `no_change` when the canonical text is the current one, `revision_conflict` on another revision.
 */
export function commitDocumentInTransaction(
	db: Database,
	caller: Caller,
	workRef: string,
	input: {
		baseRevision: number;
		title?: string;
		definition: PipelineDefinition;
	},
): { revision: number } {
	const row = loadWork(db, workRef);
	if (caller.kind === "specialist") {
		if (caller.workRef !== row.id || row.busy_run_id !== caller.runId)
			fail("turn_not_current");
	} else if (row.busy_run_id !== null) fail("work_busy");
	if (row.revision !== input.baseRevision) fail("revision_conflict");
	const text = canonicalText(input.definition);
	const title = input.title ?? input.definition.title;
	if (text === row.text && title === row.title) fail("no_change");
	const revision = row.revision + 1;
	updateWork(db, row.id, {
		revision,
		title,
		text,
		previous_text: row.text,
		rejected_json: null,
	});
	putVersion(db, {
		workId: row.id,
		revision,
		title,
		text,
		origin: caller.kind === "ui" ? "user_edit" : "edit",
	});
	bumpStudioRevision(db);
	return { revision };
}
/** Keep a whole draft that failed its check (replacing the one kept before); the shown revision stays. */
export function rejectDocumentInTransaction(
	db: Database,
	workRef: string,
	draft: Omit<RejectedDraft, "createdAt">,
) {
	const row = loadWork(db, workRef);
	const kept: RejectedDraft = {
		...draft,
		text: draft.text.slice(0, REJECTED_TEXT_CHARS),
		createdAt: new Date().toISOString(),
	};
	updateWork(db, row.id, { rejected_json: JSON.stringify(kept) });
	bumpStudioRevision(db);
}

/** An earlier outcome of the same request; the same id with other input is refused. */
function replayOf(db: Database, requestId: string, digest: string) {
	const saved = receipt(db, requestId);
	if (!saved) return null;
	if (saved.input_digest !== digest) fail("request_conflict");
	return {
		receipt: JSON.parse(saved.receipt_json) as WorkReceipt,
		replay: true,
	};
}
function accept(
	db: Database,
	requestId: string,
	digest: string,
	value: WorkReceipt,
) {
	saveReceipt(db, requestId, value.workRef, digest, value);
	bumpStudioRevision(db);
	return { receipt: value, replay: false };
}

/**
 * The user's own edit of the source text from the screen: checked for its format, then a new revision. A text that
 * fails is kept as the rejected draft, so the screen shows where it fails; the shown revision stays.
 */
export function applySourceInTransaction(
	db: Database,
	input: { workRef: string; expectedRevision: number; text: string },
	requestId: string,
) {
	const digest = hash({ op: "source.apply", input });
	const replay = replayOf(db, requestId, digest);
	if (replay) return replay;
	const checked = checkText(input.text);
	if (!checked.ok) {
		const row = loadWork(db, input.workRef);
		if (row.busy_run_id !== null) fail("work_busy");
		if (row.revision !== input.expectedRevision) fail("revision_conflict");
		rejectDocumentInTransaction(db, row.id, {
			title: row.title,
			text: input.text,
			issues: checked.issues,
			fixes: [],
		});
		return accept(db, requestId, digest, {
			workRef: row.id,
			state: "rejected",
			revision: row.revision,
		});
	}
	const { revision } = commitDocumentInTransaction(
		db,
		{ kind: "ui" },
		input.workRef,
		{
			baseRevision: input.expectedRevision,
			definition: (checked as { value: PipelineDefinition }).value,
		},
	);
	return accept(db, requestId, digest, {
		workRef: input.workRef,
		state: "drafted",
		revision,
	});
}

/**
 * The draft at `expectedRevision`, for publishing from the screen: no turn may hold the work, and the screen must
 * have seen this revision. The application publishes it and then records it with `recordPublishedInTransaction`.
 */
export function draftToPublishInTransaction(
	db: Database,
	input: { workRef: string; expectedRevision: number },
	requestId: string,
) {
	const digest = hash({ op: "publish", input });
	const replay = replayOf(db, requestId, digest);
	if (replay) return { replay, digest };
	const row = loadWork(db, input.workRef);
	if (row.busy_run_id !== null) fail("work_busy");
	if (row.revision !== input.expectedRevision) fail("revision_conflict");
	if (!row.text) fail("work_empty");
	const checked = checkText(row.text);
	if (!checked.ok) fail(checked.code);
	return {
		replay: null,
		digest,
		definition: (checked as { value: PipelineDefinition }).value,
	};
}
export function recordPublishedInTransaction(
	db: Database,
	input: { workRef: string; toolchainId: string },
	requestId: string,
	digest: string,
) {
	const row = loadWork(db, input.workRef);
	updateWork(db, row.id, {
		target_id: input.toolchainId,
		published_digest: hash(row.text),
	});
	return accept(db, requestId, digest, {
		workRef: row.id,
		state: "published",
		revision: row.revision,
		toolchainId: input.toolchainId,
	});
}
