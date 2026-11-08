import { assertLibraryIdle } from "../repository/library-operations";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ArchivePort, ArchivedDocument } from "../contracts";
import type { Workspace, PendingSave } from "../repository";
import { restoreDocument } from "./archive-content";
import { staged } from "./inputs";
import { required, view } from "./workspace";

export function createArchiveLibrary(store: SqliteStore, archive: ArchivePort) {
	return {
		capabilities: (signal: AbortSignal) => archive.capabilities(signal),
		library: (signal: AbortSignal, cursor?: string) =>
			archive.list(signal, cursor),
		async preview(sourceId: string, signal: AbortSignal) {
			const binding = archive.binding(),
				remote = await archive.read(sourceId, signal);
			if (archive.binding() !== binding)
				throw new Error("markdown_archive_unavailable");
			return { ...remote, document: restoreDocument(remote.recovery) };
		},
		async open(
			sourceId: string,
			signal: AbortSignal,
			input: {
				stageId?: string;
				expectedEtag?: string;
				replaceRevision?: number;
			} = {},
		) {
			const binding = archive.binding(),
				remote = await archive.read(sourceId, signal);
			const restored = restoreDocument(remote.recovery);
			return store.write((db) => {
				signal.throwIfAborted();
				if (!binding || archive.binding() !== binding)
					throw new Error("markdown_archive_unavailable");
				assertLibraryIdle(db, binding, remote.entry.namespace);
				const imported = input.stageId ? staged(db, input.stageId) : null;
				if (input.expectedEtag && input.expectedEtag !== remote.entry.revision)
					throw new Error("revision_conflict");
				if (
					!restored &&
					(!imported || input.expectedEtag !== remote.entry.revision)
				)
					throw new Error("markdown_import_required");
				const document = restored ?? JSON.parse(imported!.content_json);
				if (!restored && document.originalMarkdown !== remote.markdown)
					throw new Error("markdown_source_invalid");
				const existing = db
					.query(
						"SELECT * FROM markdown_workspaces WHERE source_id=? AND (remote_binding=? OR remote_binding IS NULL) ORDER BY remote_binding DESC LIMIT 1",
					)
					.get(sourceId, binding) as Workspace | null;
				if (existing?.save_job_id || existing?.save_state === "unknown")
					throw new Error("markdown_save_in_progress");
				if (
					existing &&
					(existing.revision !== existing.archived_revision ||
						existing.save_state === "conflict") &&
					input.replaceRevision !== existing.revision
				)
					throw new Error("revision_conflict");
				if (
					input.replaceRevision !== undefined &&
					(!existing || existing.revision !== input.replaceRevision)
				)
					throw new Error("revision_conflict");
				const id = existing?.id ?? crypto.randomUUID(),
					revision = (existing?.revision ?? 0) + 1;
				const content = JSON.stringify(document),
					now = Date.now();
				db.query(
					`INSERT INTO markdown_workspaces(id,title,content_json,revision,source_id,remote_revision,archived_revision,save_state,updated_at,created_at,saved_content_json,saved_title,remote_namespace,remote_path,remote_binding,markdown,saved_markdown,saved_recovery)
VALUES(?,?,?,?,?,?,?,'saved',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_json=excluded.content_json,revision=excluded.revision,source_id=excluded.source_id,remote_revision=excluded.remote_revision,archived_revision=excluded.archived_revision,save_state='saved',save_error=NULL,conflict_json=NULL,updated_at=excluded.updated_at,saved_content_json=excluded.saved_content_json,saved_title=excluded.saved_title,remote_namespace=excluded.remote_namespace,remote_path=excluded.remote_path,remote_binding=excluded.remote_binding,markdown=excluded.markdown,saved_markdown=excluded.saved_markdown,saved_recovery=excluded.saved_recovery`,
				).run(
					id,
					remote.entry.title,
					content,
					revision,
					sourceId,
					remote.entry.revision,
					revision,
					now,
					now,
					content,
					remote.entry.title,
					remote.entry.namespace,
					remote.entry.path,
					binding,
					remote.markdown,
					remote.markdown,
					remote.recovery,
				);
				db.query("DELETE FROM markdown_saves WHERE document_id=?").run(id);
				if (input.stageId)
					db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
				return view(db, id);
			});
		},
		resolve(documentId: string, revision: number, etag: string) {
			return store.write((db) => {
				const current = required(db, documentId);
				const pending = db
					.query("SELECT * FROM markdown_saves WHERE document_id=?")
					.get(documentId) as PendingSave | null;
				const latest = current.conflict_json
					? (JSON.parse(current.conflict_json) as ArchivedDocument)
					: null;
				if (
					current.save_state !== "conflict" ||
					current.save_job_id ||
					current.revision !== revision ||
					!pending ||
					!latest ||
					latest.entry.revision !== etag ||
					archive.binding() !== pending.binding
				)
					throw new Error("revision_conflict");
				if (
					latest.entry.sourceId !== pending.source_id ||
					latest.entry.namespace !== pending.namespace ||
					latest.entry.path !== pending.path
				)
					throw new Error("markdown_archive_conflict");
				// The user explicitly chose this ETag as the base. Saving remains a separate action.
				db.query(
					"UPDATE markdown_workspaces SET remote_revision=?,save_state='unsaved',save_error=NULL,conflict_json=NULL,revision=revision+1 WHERE id=?",
				).run(etag, documentId);
				db.query("DELETE FROM markdown_saves WHERE id=?").run(pending.id);
				return view(db, documentId);
			});
		},
	};
}
