import type { SqliteStore } from "../../../infrastructure/sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import { ArchiveFailure, type ArchivePort } from "../contracts";
import {
	manageInput,
	libraryCommand,
	type LibraryCommand,
	type OperationView,
	type LibraryEntry,
} from "../contracts/library";
import {
	managementRow,
	assertLibraryIdle,
	type ManagementRow,
} from "../repository/library-operations";
import type { Workspace } from "../repository";
import {
	captureManifest,
	matchesManifest,
	type Expected,
} from "./library-manifest";
const visible = (r: ManagementRow): OperationView => ({
	id: r.id,
	state: r.state,
	code: r.code,
	command: JSON.parse(r.command_json),
	removedWorkspaceIds: JSON.parse(r.removed_json),
});
export function createLibraryManagement(
	store: SqliteStore,
	archive: ArchivePort,
	publish?: () => void,
) {
	const running = new Set<string>();
	async function finish(
		id: string,
		state: ManagementRow["state"],
		code: string | null,
		signal: AbortSignal,
		metadata: LibraryEntry[] = [],
	) {
		const r = await store.read((db) => managementRow(db, id));
		if (!r) throw new Error("markdown_not_found");
		if (archive.binding() !== r.binding || signal.aborted) return visible(r);
		const expected = JSON.parse(r.expected_json) as Expected[],
			command = JSON.parse(r.command_json) as LibraryCommand;
		return store.write((db) => {
			signal.throwIfAborted();
			const current = managementRow(db, id)!;
			if (current.state !== "unknown" || archive.binding() !== r.binding)
				return visible(current);
			const removed: string[] = [];
			if (state === "applied" || state === "confirmed") {
				if (
					command.op === "delete" ||
					(command.op === "batch" && command.action === "delete")
				)
					for (const e of expected) {
						const rows = db
							.query(
								"SELECT id FROM markdown_workspaces WHERE source_id=? AND remote_binding=?",
							)
							.all(e.id, r.binding) as { id: string }[];
						for (const w of rows) {
							db.query("DELETE FROM markdown_sessions WHERE document_id=?").run(
								w.id,
							);
							db.query("DELETE FROM markdown_saves WHERE document_id=?").run(
								w.id,
							);
							db.query("DELETE FROM markdown_workspaces WHERE id=?").run(w.id);
							removed.push(w.id);
						}
					}
				if (
					command.op === "patch" ||
					(command.op === "batch" && command.action === "move")
				)
					for (const e of metadata)
						if (e.kind === "document")
							db.query(
								"UPDATE markdown_workspaces SET title=?,saved_title=?,remote_path=?,remote_namespace=?,remote_revision=?,revision=revision+1,archived_revision=revision+1,save_state='saved',save_error=NULL,conflict_json=NULL WHERE source_id=? AND remote_binding=?",
							).run(
								e.title,
								e.title,
								e.path,
								e.namespace,
								e.etag,
								e.id,
								r.binding,
							);
			}
			db.query(
				"UPDATE markdown_operations SET state=?,code=?,removed_json=? WHERE id=? AND state='unknown'",
			).run(state, code, JSON.stringify(removed), id);
			publish?.();
			return visible(managementRow(db, id)!);
		});
	}
	async function check(id: string, signal: AbortSignal) {
		const r = await store.read((db) => managementRow(db, id));
		if (!r || archive.binding() !== r.binding)
			throw new Error("markdown_not_found");
		if (r.state !== "unknown" || running.has(id)) return visible(r);
		const metadata = await matchesManifest(
			archive.management!,
			JSON.parse(r.expected_json),
			signal,
		);
		if (metadata) return finish(id, "confirmed", null, signal, metadata);
		return visible(r);
	}
	return {
		stageManagement(input: unknown) {
			const value = manageInput.parse(input),
				id = crypto.randomUUID();
			return store.write((db) => {
				db.query("DELETE FROM markdown_inputs WHERE expires_at<?").run(
					Date.now(),
				);
				db.query(
					"INSERT INTO markdown_inputs(id,content_json,markdown,expires_at) VALUES(?,?,NULL,?)",
				).run(id, JSON.stringify(value), Date.now() + 600000);
				return { id };
			});
		},
		async manageStaged(id: string, signal: AbortSignal) {
			signal.throwIfAborted();
			const input = await store.read(
				(db) =>
					db
						.query(
							"SELECT content_json FROM markdown_inputs WHERE id=? AND expires_at>?",
						)
						.get(id, Date.now()) as { content_json: string } | null,
			);
			if (!input) throw new Error("markdown_not_found");
			return manageInput.parse(JSON.parse(input.content_json));
		},
		files: async (
			input: { namespace: string; path: string; cursor?: string },
			signal: AbortSignal,
		) => {
			if (!archive.management) throw new Error("markdown_library_unsupported");
			return archive.management.listLibrary(input, signal);
		},
		operations: () =>
			store.read((db) =>
				(
					db
						.query(
							"SELECT * FROM markdown_operations WHERE binding=? ORDER BY created_at DESC LIMIT 100",
						)
						.all(archive.binding() ?? "") as ManagementRow[]
				).map(visible),
			),
		check,
		async manage(requestId: string, raw: LibraryCommand, signal: AbortSignal) {
			const command = libraryCommand.parse(raw),
				binding = archive.binding();
			if (!binding || !archive.management)
				throw new Error("markdown_library_unsupported");
			const existing = await store.read((db) => managementRow(db, requestId));
			if (existing) {
				if (
					existing.binding !== binding ||
					canonicalJson(command, {
						keyOrder: "codeUnit",
						omitUndefined: true,
					}) !==
						canonicalJson(JSON.parse(existing.command_json), {
							keyOrder: "codeUnit",
							omitUndefined: true,
						})
				)
					throw new Error("request_conflict");
				return visible(existing);
			}
			const { before, expected } = await captureManifest(
				archive,
				command,
				signal,
			);
			const admitted = await store.write((db) => {
				signal.throwIfAborted();
				if (archive.binding() !== binding)
					throw new Error("markdown_archive_unavailable");
				const duplicate = managementRow(db, requestId);
				if (duplicate) {
					if (
						canonicalJson(command, {
							keyOrder: "codeUnit",
							omitUndefined: true,
						}) !==
						canonicalJson(JSON.parse(duplicate.command_json), {
							keyOrder: "codeUnit",
							omitUndefined: true,
						})
					)
						throw new Error("request_conflict");
					return false;
				}
				assertLibraryIdle(db, binding, command.namespace);
				if (
					db
						.query(
							"SELECT id FROM markdown_generated WHERE binding=? AND json_extract(input_json,'$.namespace')=? AND (state='pending' OR json_extract(archive_json,'$.state')='unknown') LIMIT 1",
						)
						.get(binding, command.namespace)
				)
					throw new Error("markdown_save_in_progress");
				const work = db
					.query(
						"SELECT * FROM markdown_workspaces WHERE remote_binding=? AND remote_namespace=?",
					)
					.all(binding, command.namespace) as Workspace[];
				if (work.some((w) => w.save_job_id || w.save_state === "unknown"))
					throw new Error("markdown_save_in_progress");
				const affected = work.filter((w) =>
					before.some((e) => e.id === w.source_id),
				);
				if (
					affected.some(
						(w) =>
							w.revision !== w.archived_revision || w.save_state === "conflict",
					)
				)
					throw new Error("markdown_unsaved_changes");
				if (
					affected.some((w) =>
						db
							.query("SELECT id FROM markdown_sessions WHERE document_id=?")
							.get(w.id),
					)
				)
					throw new Error("work_busy");
				db.query(
					"INSERT INTO markdown_operations(id,binding,namespace,command_json,expected_json,state,created_at) VALUES(?,?,?,?,?,'unknown',?)",
				).run(
					requestId,
					binding,
					command.namespace,
					JSON.stringify(command),
					JSON.stringify(expected),
					Date.now(),
				);
				return true;
			});
			if (!admitted)
				return visible(
					(await store.read((db) => managementRow(db, requestId)))!,
				);
			running.add(requestId);
			try {
				await archive.management.manage(command, signal, binding);
				if (archive.binding() !== binding || signal.aborted)
					return visible(
						(await store.read((db) => managementRow(db, requestId)))!,
					);
				const metadata = await matchesManifest(
					archive.management,
					expected,
					signal,
				);
				if (metadata)
					return await finish(requestId, "applied", null, signal, metadata);
				return visible(
					(await store.read((db) => managementRow(db, requestId)))!,
				);
			} catch (e) {
				if (
					e instanceof ArchiveFailure &&
					e.outcome !== "unknown" &&
					!signal.aborted
				)
					return await finish(
						requestId,
						e.outcome === "conflict" ? "conflict" : "failed",
						e.code,
						signal,
					);
				if (!signal.aborted && archive.binding() === binding) {
					const metadata = await matchesManifest(
						archive.management,
						expected,
						signal,
					);
					if (metadata)
						return await finish(requestId, "confirmed", null, signal, metadata);
				}
				return visible(
					(await store.read((db) => managementRow(db, requestId)))!,
				);
			} finally {
				running.delete(requestId);
				publish?.();
			}
		},
	};
}
