import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ArchivePort } from "../contracts";
import type { PendingSave } from "../repository";
import { required, view } from "./workspace";

/** A fresh GET reconciliation. It never resends an uncertain import. */
export function createArchiveRecovery(
	store: SqliteStore,
	archive: ArchivePort,
) {
	return async (documentId: string, signal: AbortSignal) => {
		const frozen = store.read(
			(db) =>
				db
					.query("SELECT * FROM markdown_saves WHERE document_id=?")
					.get(documentId) as PendingSave | null,
		);
		if (!frozen) throw new Error("markdown_not_found");
		const binding = archive.binding();
		const entry = (await archive.list(signal)).find(
			(item) => item.documentId === documentId,
		);
		const remote = entry ? await archive.read(entry.sourceId, signal) : null;
		signal.throwIfAborted();
		const matches =
			remote &&
			JSON.stringify(remote.document) === frozen.content_json &&
			remote.entry.title === frozen.title;
		return store.write((db) => {
			signal.throwIfAborted();
			const current = required(db, documentId);
			const pending = db
				.query("SELECT id FROM markdown_saves WHERE document_id=?")
				.get(documentId) as { id: string } | null;
			if (
				archive.binding() !== binding ||
				current.save_job_id ||
				current.save_state !== "unknown" ||
				pending?.id !== frozen.id
			)
				throw new Error("revision_conflict");
			if (remote && matches) {
				db.query(
					"UPDATE markdown_workspaces SET source_id=?,remote_revision=?,archived_revision=?,saved_content_json=?,saved_title=?,save_state='saved',save_error=NULL WHERE id=?",
				).run(
					remote.entry.sourceId,
					remote.entry.revision,
					frozen.revision,
					frozen.content_json,
					frozen.title,
					documentId,
				);
				db.query("DELETE FROM markdown_saves WHERE id=?").run(frozen.id);
			} else if (!remote && !frozen.source_id) {
				db.query(
					"UPDATE markdown_workspaces SET save_state='unsaved',save_error=NULL WHERE id=?",
				).run(documentId);
				db.query("DELETE FROM markdown_saves WHERE id=?").run(frozen.id);
			} else
				db.query(
					"UPDATE markdown_workspaces SET save_error='markdown_archive_conflict' WHERE id=?",
				).run(documentId);
			return view(db, documentId);
		});
	};
}
