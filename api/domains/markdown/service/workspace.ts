import type { Database } from "bun:sqlite";
import { sha256Hex, canonicalJson } from "../../../infrastructure/digest";
import {
	editorDocumentSchema,
	emptyDocument,
	checkDocument,
	title as titleSchema,
	type EditorDocument,
} from "../contracts";
import { row, list, session } from "../repository";

export function required(db: Database, documentId: string) {
	const value = row(db, documentId);
	if (!value) throw new Error("markdown_not_found");
	return value;
}
export function view(db: Database, documentId: string) {
	const value = required(db, documentId);
	return {
		id: value.id,
		title: value.title,
		document: editorDocumentSchema.parse(JSON.parse(value.content_json)),
		revision: value.revision,
		sourceId: value.source_id,
		markdown: value.markdown,
		remote: value.source_id
			? {
					id: value.source_id,
					etag: value.remote_revision,
					namespace: value.remote_namespace,
					path: value.remote_path,
				}
			: null,
		conflict: value.conflict_json ? JSON.parse(value.conflict_json) : null,
		archivedRevision: value.archived_revision,
		dirty: value.revision !== value.archived_revision,
		saveState: value.save_state,
		saveError: value.save_error,
	};
}
export function create(
	db: Database,
	name: string,
	document: EditorDocument = emptyDocument(),
	markdown: string | null = null,
) {
	const documentId = crypto.randomUUID();
	db.query(
		"INSERT INTO markdown_workspaces(id,title,content_json,revision,updated_at,created_at,markdown) VALUES(?,?,?,1,?,?,?)",
	).run(
		documentId,
		titleSchema.parse(name),
		JSON.stringify(editorDocumentSchema.parse(document)),
		Date.now(),
		Date.now(),
		markdown,
	);
	return view(db, documentId);
}
export function apply(
	db: Database,
	documentId: string,
	baseRevision: number,
	name: string | undefined,
	document: EditorDocument,
) {
	const current = required(db, documentId);
	if (current.revision !== baseRevision) throw new Error("revision_conflict");
	const checked = editorDocumentSchema.parse(document);
	const title = name === undefined ? current.title : titleSchema.parse(name);
	const content = JSON.stringify(checked);
	if (title === current.title && content === current.content_json)
		return { revision: current.revision };
	db.query(
		"UPDATE markdown_workspaces SET title=?,content_json=?,markdown=CASE WHEN content_json=? THEN markdown ELSE NULL END,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
	).run(title, content, content, Date.now(), documentId, baseRevision);
	return { revision: baseRevision + 1 };
}
export function replay<T>(
	db: Database,
	requestId: string,
	input: unknown,
	action: () => T,
): T {
	const digest = sha256Hex(
		canonicalJson(input, { omitUndefined: true, keyOrder: "codeUnit" }),
	);
	const stored = db
		.query(
			"SELECT digest,receipt_json FROM markdown_receipts WHERE request_id=?",
		)
		.get(requestId) as { digest: string; receipt_json: string } | null;
	if (stored) {
		if (stored.digest !== digest) throw new Error("request_conflict");
		return JSON.parse(stored.receipt_json) as T;
	}
	const value = action();
	db.query("INSERT INTO markdown_receipts VALUES(?,?,?)").run(
		requestId,
		digest,
		JSON.stringify(value),
	);
	return value;
}
export function workState(db: Database, workRef: string) {
	const work = session(db, workRef);
	if (!work) return null;
	const document = view(db, work.document_id);
	return {
		workRef: work.id,
		savedRef: document.id,
		dirty: document.dirty,
		busy: work.busy_run_id !== null,
		revision: document.revision,
		label: document.title,
		current: { documentId: document.id, archiveState: document.saveState },
		context: {
			savedIn: "Docling Desk",
			archivedRevision: document.archivedRevision,
		},
	};
}
export function sessionAdapter() {
	return {
		hasTargetInTransaction: (db: Database, targetRef: string) =>
			!!row(db, targetRef),
		openInTransaction(
			db: Database,
			input: { sessionId: string; targetRef: string | null },
		) {
			const target = input.targetRef
				? view(db, input.targetRef)
				: create(db, "無題");
			if (
				db
					.query("SELECT id FROM markdown_sessions WHERE document_id=?")
					.get(target.id)
			)
				throw new Error("work_busy");
			const workRef = crypto.randomUUID();
			db.query(
				"INSERT INTO markdown_sessions(id,document_id,session_id) VALUES(?,?,?)",
			).run(workRef, target.id, input.sessionId);
			return workState(db, workRef)!;
		},
		stateInTransaction: workState,
		beginTurnInTransaction(db: Database, workRef: string, runId: string) {
			const work = session(db, workRef);
			if (!work) throw new Error("markdown_not_found");
			if (work.busy_run_id !== null && work.busy_run_id !== runId)
				throw new Error("work_busy");
			db.query("UPDATE markdown_sessions SET busy_run_id=? WHERE id=?").run(
				runId,
				workRef,
			);
		},
		endTurnInTransaction(db: Database, workRef: string, runId: string) {
			db.query(
				"UPDATE markdown_sessions SET busy_run_id=NULL WHERE id=? AND busy_run_id=?",
			).run(workRef, runId);
		},
		endInTransaction(db: Database, workRef: string, mode: "discard" | "close") {
			const work = session(db, workRef);
			if (!work) return;
			const value = required(db, work.document_id);
			if (value.save_job_id || work.busy_run_id) throw new Error("work_busy");
			if (mode === "close" && value.revision !== value.archived_revision)
				throw new Error("work_unsaved");
			if (mode === "discard" && value.revision !== value.archived_revision) {
				const restored =
					value.saved_content_json ?? JSON.stringify(emptyDocument());
				db.query(
					"UPDATE markdown_workspaces SET content_json=?,title=?,revision=revision+1,archived_revision=CASE WHEN source_id IS NULL THEN 0 ELSE revision+1 END,updated_at=? WHERE id=?",
				).run(restored, value.saved_title ?? "無題", Date.now(), value.id);
			}
			db.query("DELETE FROM markdown_sessions WHERE id=?").run(workRef);
		},
		document: {
			readInTransaction(db: Database, workRef: string) {
				const work = session(db, workRef);
				if (!work) return null;
				const document = view(db, work.document_id);
				return {
					revision: document.revision,
					title: document.title,
					text: JSON.stringify(document.document, null, 2),
					rejected: work.rejected_json ? JSON.parse(work.rejected_json) : null,
				};
			},
			check: checkDocument,
			commitInTransaction(
				db: Database,
				workRef: string,
				input: {
					baseRevision: number;
					title?: string;
					value: unknown;
					origin: { kind: string; workRef?: string; runId?: string };
				},
			) {
				const work = session(db, workRef);
				if (
					!work ||
					input.origin.kind !== "specialist" ||
					input.origin.workRef !== workRef ||
					work.busy_run_id !== input.origin.runId
				)
					throw new Error("turn_not_current");
				const result = apply(
					db,
					work.document_id,
					input.baseRevision,
					input.title,
					editorDocumentSchema.parse(input.value),
				);
				db.query(
					"UPDATE markdown_sessions SET rejected_json=NULL WHERE id=?",
				).run(workRef);
				return result;
			},
			rejectInTransaction(
				db: Database,
				workRef: string,
				draft: {
					title: string;
					text: string;
					issues: unknown[];
					fixes: string[];
				},
			) {
				db.query("UPDATE markdown_sessions SET rejected_json=? WHERE id=?").run(
					JSON.stringify({
						...draft,
						text: draft.text.slice(0, 65536),
						createdAt: new Date().toISOString(),
					}),
					workRef,
				);
			},
		},
	};
}
export { list };
