import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ArchivePort } from "../contracts";
import type { PendingSave } from "../repository";
import { required, view } from "./workspace";
import { adoptSave, confirmSave, frozenSave } from "./archive-save";

/** Reconcile the frozen PUT through bounded GETs. Never resend an uncertain write. */
export function createArchiveRecovery(
	store: SqliteStore,
	archive: ArchivePort,
) {
	return async (documentId: string, signal: AbortSignal) => {
		const pending = store.read(
			(db) =>
				db
					.query("SELECT * FROM markdown_saves WHERE document_id=?")
					.get(documentId) as PendingSave | null,
		);
		if (!pending) throw new Error("markdown_not_found");
		const frozen = frozenSave(pending);
		if (archive.binding() !== frozen.binding)
			throw new Error("markdown_archive_unavailable");
		const conflict = store.read(
			(db) => required(db, documentId).save_state === "conflict",
		);
		const outcome = await confirmSave(archive, frozen, signal, conflict);
		return store.write((db) => {
			signal.throwIfAborted();
			const current = required(db, documentId);
			const latest = db
				.query("SELECT id FROM markdown_saves WHERE document_id=?")
				.get(documentId) as { id: string } | null;
			if (
				archive.binding() !== frozen.binding ||
				current.save_job_id ||
				!["unknown", "conflict"].includes(current.save_state) ||
				latest?.id !== pending.id
			)
				throw new Error("revision_conflict");
			adoptSave(db, pending, outcome);
			return view(db, documentId);
		});
	};
}
