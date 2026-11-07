import { createArchiveRecovery } from "./archive-recovery";
import { encodeArchive } from "./archive-format";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService, HandlerDefinition } from "../../queue";
import {
	applyInput,
	newInput,
	saveInput,
	stageInput,
	type ArchiveEntry,
	type ArchivePort,
	type EditorDocument,
} from "../contracts";
import { row, session, list, type PendingSave as Save } from "../repository";
import {
	required,
	view,
	create,
	apply,
	replay,
	sessionAdapter,
} from "./workspace";

type SaveResult =
	{ ok: true; entry: ArchiveEntry } | { ok: false; code: string };
export function createMarkdown(deps: {
	store: SqliteStore;
	queue: QueueService;
	archive: ArchivePort;
	publish?: () => void;
}) {
	const { store, queue, archive } = deps;
	function staged(db: Database, id: string) {
		const value = db
			.query(
				"SELECT content_json,markdown,expires_at FROM markdown_inputs WHERE id=?",
			)
			.get(id) as {
			content_json: string;
			markdown: string | null;
			expires_at: number;
		} | null;
		if (!value || value.expires_at < Date.now())
			throw new Error("markdown_input_expired");
		return value;
	}
	const handler: HandlerDefinition<{ id: string }, Save, SaveResult> = {
		kind: "markdown.archive",
		payloadVersions: [1],
		schema: z.strictObject({ id: z.uuid() }),
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const input = db
				.query("SELECT * FROM markdown_saves WHERE id=?")
				.get(claim.payload.id) as Save | null;
			if (!input || row(db, input.document_id)?.save_job_id !== claim.jobId)
				return { status: "stale", reason: "markdown_save_changed" };
			return { status: "ready", input };
		},
		async execute(input, { signal }) {
			try {
				const entry = await archive.save(
					{
						documentId: input.document_id,
						title: input.title,
						document: JSON.parse(input.content_json) as EditorDocument,
						markdown: input.markdown,
						sourceId: input.source_id,
						remoteRevision: input.remote_revision,
						binding: input.binding,
					},
					AbortSignal.any([signal, AbortSignal.timeout(190000)]),
				);
				return { ok: true, entry };
			} catch (error) {
				const code =
					error instanceof Error &&
					error.message === "markdown_archive_conflict"
						? error.message
						: "markdown_archive_unknown";
				return { ok: false, code };
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			input ??= db
				.query("SELECT * FROM markdown_saves WHERE id=?")
				.get(claim.payload.id) as Save | null;
			const document = input ? row(db, input.document_id) : null;
			if (!input || !document || document.save_job_id !== claim.jobId)
				return "stale";
			const result: SaveResult =
				outcome.type === "success" && archive.binding() === input.binding
					? outcome.result
					: { ok: false, code: "markdown_archive_unknown" };
			if (result.ok) {
				db.query(
					"UPDATE markdown_workspaces SET source_id=?,remote_revision=?,archived_revision=?,saved_content_json=?,saved_title=?,save_job_id=NULL,save_state='saved',save_error=NULL,updated_at=? WHERE id=? AND save_job_id=?",
				).run(
					result.entry.sourceId,
					result.entry.revision,
					input.revision,
					input.content_json,
					input.title,
					Date.now(),
					input.document_id,
					claim.jobId,
				);
			} else
				db.query(
					"UPDATE markdown_workspaces SET save_job_id=NULL,save_state='unknown',save_error=?,updated_at=? WHERE id=? AND save_job_id=?",
				).run(result.code, Date.now(), input.document_id, claim.jobId);
			if (result.ok)
				db.query("DELETE FROM markdown_saves WHERE id=?").run(input.id);
			return result.ok
				? "applied"
				: { status: "failed", errorCode: result.code };
		},
		cancelInTransaction(db, job) {
			db.query(
				"UPDATE markdown_workspaces SET save_job_id=NULL,save_state='unknown',save_error='markdown_archive_unknown' WHERE save_job_id=?",
			).run(job.jobId);
			// Keep the one frozen input for an explicit read-only reconciliation.
		},
		afterCommit: deps.publish,
	};
	queue.registerHandler(handler);
	const service = {
		available: archive.available,
		async stage(raw: unknown) {
			const input = stageInput.parse(raw),
				id = crypto.randomUUID();
			await store.write((db) => {
				db.query("DELETE FROM markdown_inputs WHERE expires_at<?").run(
					Date.now(),
				);
				if (
					(
						db.query("SELECT count(*) AS n FROM markdown_inputs").get() as {
							n: number;
						}
					).n >= 20
				)
					throw new Error("markdown_input_full");
				db.query("INSERT INTO markdown_inputs VALUES(?,?,?,?)").run(
					id,
					JSON.stringify(input.document),
					input.markdown ?? null,
					Date.now() + 3600000,
				);
			});
			return { id };
		},
		listInTransaction: list,
		viewInTransaction: view,
		session: sessionAdapter(),
		currentInTransaction(db: Database, targetRef?: string, workRef?: string) {
			const work = workRef ? session(db, workRef) : null;
			const selected = targetRef ?? work?.document_id;
			return {
				kind: "markdown-workspace",
				revision: selected ? (row(db, selected)?.revision ?? 0) : 0,
				current: selected && row(db, selected) ? view(db, selected) : null,
				documents: list(db),
				archiveAvailable: archive.available(),
			};
		},
		invokeInTransaction(
			db: Database,
			operation: string,
			raw: unknown,
			requestId: string,
		) {
			return replay(db, requestId, { operation, input: raw }, () => {
				if (operation === "markdown.new") {
					const input = newInput.parse(raw),
						source = staged(db, input.stageId);
					const document = create(
						db,
						input.title,
						JSON.parse(source.content_json),
					);
					db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
					return {
						documentId: document.id,
						revision: document.revision,
						state: "draft",
					};
				}
				if (operation === "markdown.apply") {
					const input = applyInput.parse(raw),
						source = staged(db, input.stageId);
					const result = apply(
						db,
						input.documentId,
						input.expectedRevision,
						input.title,
						JSON.parse(source.content_json),
					);
					db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
					return {
						documentId: input.documentId,
						revision: result.revision,
						state: "draft",
					};
				}
				if (operation !== "markdown.archive")
					throw new Error("markdown_operation_unknown");
				const input = saveInput.parse(raw),
					document = required(db, input.documentId),
					source = staged(db, input.stageId);
				if (
					source.content_json !== document.content_json ||
					source.markdown === null
				)
					throw new Error("revision_conflict");
				if (document.revision !== input.expectedRevision)
					throw new Error("revision_conflict");
				// Enforce the Desk wire format limit before accepting a job or sending any POST.
				encodeArchive(
					document.id,
					document.title,
					JSON.parse(document.content_json),
					source.markdown,
				);
				if (document.save_job_id) throw new Error("markdown_save_in_progress");
				if (document.save_state === "unknown")
					throw new Error("markdown_archive_unknown");
				const binding = archive.binding();
				if (!binding) throw new Error("markdown_archive_unavailable");
				db.query("INSERT INTO markdown_saves VALUES(?,?,?,?,?,?,?,?,?)").run(
					requestId,
					document.id,
					document.title,
					document.content_json,
					source.markdown,
					document.revision,
					document.source_id,
					document.remote_revision,
					binding,
				);
				db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
				const { job } = queue.enqueueInTransaction(db, {
					scope: "markdown",
					kind: "markdown.archive",
					dedupeKey: requestId,
					payload: { id: requestId },
					subjectRef: document.id,
					lane: "interactive",
					concurrencyKey: `markdown:${document.id}`,
					maxAttempts: 1,
					deadlineAtMs: Date.now() + 200000,
				});
				db.query(
					"UPDATE markdown_workspaces SET save_job_id=?,save_state='saving',save_error=NULL WHERE id=?",
				).run(job.id, document.id);
				return {
					documentId: document.id,
					revision: document.revision,
					state: "saving",
				};
			});
		},
		receiptInTransaction(db: Database, requestId: string) {
			const stored = db
				.query("SELECT receipt_json FROM markdown_receipts WHERE request_id=?")
				.get(requestId) as { receipt_json: string } | null;
			return stored
				? (JSON.parse(stored.receipt_json) as {
						documentId: string;
						revision: number;
						state: string;
					})
				: null;
		},
		reconcile: createArchiveRecovery(store, archive),
		async library(signal: AbortSignal) {
			return { items: await archive.list(signal) };
		},
		async open(sourceId: string, signal: AbortSignal) {
			const binding = archive.binding();
			const saved = await archive.read(sourceId, signal);
			signal.throwIfAborted();
			return store.write((db) => {
				signal.throwIfAborted();
				if (archive.binding() !== binding)
					throw new Error("markdown_archive_unavailable");
				const existing = row(db, saved.entry.documentId);
				if (
					existing &&
					(existing.revision !== existing.archived_revision ||
						existing.save_job_id)
				)
					throw new Error("revision_conflict");
				const json = JSON.stringify(saved.document),
					revision = (existing?.revision ?? 0) + 1;
				db.query(
					"INSERT INTO markdown_workspaces(id,title,content_json,revision,source_id,remote_revision,archived_revision,save_state,updated_at,created_at,saved_content_json,saved_title) VALUES(?,?,?,?,?,?,?,'saved',?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_json=excluded.content_json,revision=excluded.revision,source_id=excluded.source_id,remote_revision=excluded.remote_revision,archived_revision=excluded.archived_revision,save_state='saved',save_error=NULL,updated_at=excluded.updated_at,saved_content_json=excluded.saved_content_json,saved_title=excluded.saved_title",
				).run(
					saved.entry.documentId,
					saved.entry.title,
					json,
					revision,
					saved.entry.sourceId,
					saved.entry.revision,
					revision,
					Date.now(),
					Date.now(),
					json,
					saved.entry.title,
				);
				return view(db, saved.entry.documentId);
			});
		},
		afterCommit: () => {
			queue.wake();
			deps.publish?.();
		},
	};
	return service;
}
export type MarkdownService = ReturnType<typeof createMarkdown>;
