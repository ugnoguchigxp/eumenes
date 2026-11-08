import { assertLibraryIdle } from "../repository/library-operations";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { HandlerDefinition, QueueService } from "../../queue";
import {
	ArchiveFailure,
	type ArchivePort,
	type ArchiveSave,
	type ArchiveEntry,
	type ArchivedDocument,
} from "../contracts";
import { row, type PendingSave } from "../repository";
import { required } from "./workspace";
import { archiveDigest, matchesSave } from "./archive-content";

export function frozenSave(input: PendingSave): ArchiveSave {
	if (
		!input.source_id ||
		input.namespace === null ||
		input.path === null ||
		input.recovery === null ||
		!input.content_digest
	)
		throw new ArchiveFailure("markdown_archive_unavailable", "failed");
	return {
		documentId: input.document_id,
		sourceId: input.source_id,
		title: input.title,
		markdown: input.markdown,
		recovery: input.recovery,
		remoteRevision: input.remote_revision,
		binding: input.binding,
		namespace: input.namespace,
		path: input.path,
		contentDigest: input.content_digest,
	};
}
export type SaveOutcome =
	| { ok: true; entry: ArchiveEntry }
	| {
			ok: false;
			code: string;
			state: "unknown" | "conflict" | "unsaved";
			remote?: ArchivedDocument;
	  };
/** Bounded GET-only confirmation; even repeated 404s cannot prove a pending PUT never committed. */
export async function confirmSave(
	archive: ArchivePort,
	input: ArchiveSave,
	signal: AbortSignal,
	conflict = false,
): Promise<SaveOutcome> {
	for (let attempt = 0; attempt < 3; attempt++) {
		signal.throwIfAborted();
		if (archive.binding() !== input.binding) break;
		try {
			const remote = await archive.read(input.sourceId, signal);
			if (archive.binding() !== input.binding) break;
			if (!conflict && matchesSave(remote.entry, input))
				return { ok: true, entry: remote.entry };
			return {
				ok: false,
				code: "markdown_archive_conflict",
				state: "conflict",
				remote,
			};
		} catch (error) {
			if (!(error instanceof ArchiveFailure) || error.httpStatus !== 404) break;
		}
		if (attempt < 2)
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const timer = setTimeout(done, 200 * (attempt + 1));
				const abort = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
			});
	}
	return {
		ok: false,
		code: conflict ? "markdown_archive_conflict" : "markdown_archive_unknown",
		state: conflict ? "conflict" : "unknown",
	};
}
/** One conditional PUT, followed only by bounded GET confirmation. Shared by editors and generated documents. */
export async function executeArchiveSave(
	archive: ArchivePort,
	frozen: ArchiveSave,
	signal: AbortSignal,
): Promise<SaveOutcome> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(190000)]);
	try {
		const entry = await archive.save(frozen, deadline);
		if (matchesSave(entry, frozen)) return { ok: true, entry };
		return confirmSave(
			archive,
			frozen,
			AbortSignal.any([signal, AbortSignal.timeout(30000)]),
		);
	} catch (error) {
		if (signal.aborted || archive.binding() !== frozen.binding)
			return {
				ok: false,
				code: "markdown_archive_unknown",
				state: "unknown",
			};
		if (error instanceof ArchiveFailure && error.outcome === "failed")
			return { ok: false, code: error.code, state: "unsaved" };
		const result = await confirmSave(
			archive,
			frozen,
			AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			error instanceof ArchiveFailure && error.outcome === "conflict",
		);
		if (
			!result.ok &&
			result.state === "unknown" &&
			error instanceof ArchiveFailure &&
			error.outcome === "conflict"
		)
			return {
				ok: false,
				code: "markdown_archive_conflict",
				state: "conflict",
			};
		return result;
	}
}
export function adoptSave(
	db: Database,
	input: PendingSave,
	outcome: SaveOutcome,
) {
	if (outcome.ok) {
		db.query(
			`UPDATE markdown_workspaces SET source_id=?,remote_revision=?,remote_namespace=?,remote_path=?,remote_binding=?,
archived_revision=?,saved_content_json=?,saved_title=?,saved_markdown=?,saved_recovery=?,
markdown=CASE WHEN content_json=? THEN ? ELSE markdown END,save_job_id=NULL,save_state='saved',save_error=NULL,conflict_json=NULL,updated_at=? WHERE id=?`,
		).run(
			outcome.entry.sourceId,
			outcome.entry.revision,
			outcome.entry.namespace,
			outcome.entry.path,
			input.binding,
			input.revision,
			input.content_json,
			input.title,
			input.markdown,
			input.recovery,
			input.content_json,
			input.markdown,
			Date.now(),
			input.document_id,
		);
	} else {
		db.query(
			"UPDATE markdown_workspaces SET save_job_id=NULL,save_state=?,save_error=?,conflict_json=CASE WHEN ?='conflict' AND ? IS NULL THEN conflict_json ELSE ? END,updated_at=? WHERE id=?",
		).run(
			outcome.state,
			outcome.code,
			outcome.state,
			outcome.remote ? JSON.stringify(outcome.remote) : null,
			outcome.remote ? JSON.stringify(outcome.remote) : null,
			Date.now(),
			input.document_id,
		);
	}
	if (outcome.ok || outcome.state === "unsaved")
		db.query("DELETE FROM markdown_saves WHERE id=?").run(input.id);
}
export function createArchiveSave(
	archive: ArchivePort,
	queue: QueueService,
	publish?: () => void,
) {
	const handler: HandlerDefinition<{ id: string }, PendingSave, SaveOutcome> = {
		kind: "markdown.archive",
		payloadVersions: [1],
		schema: z.strictObject({ id: z.uuid() }),
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const input = db
				.query("SELECT * FROM markdown_saves WHERE id=?")
				.get(claim.payload.id) as PendingSave | null;
			return input && row(db, input.document_id)?.save_job_id === claim.jobId
				? { status: "ready", input }
				: { status: "stale", reason: "markdown_save_changed" };
		},
		execute: (input, { signal }) =>
			executeArchiveSave(archive, frozenSave(input), signal),
		classify: () => "fail",
		settleInTransaction(db, claim, input, result) {
			input ??= db
				.query("SELECT * FROM markdown_saves WHERE id=?")
				.get(claim.payload.id) as PendingSave | null;
			if (!input || row(db, input.document_id)?.save_job_id !== claim.jobId)
				return "stale";
			const outcome: SaveOutcome =
				result.type === "success" && archive.binding() === input.binding
					? result.result
					: { ok: false, code: "markdown_archive_unknown", state: "unknown" };
			adoptSave(db, input, outcome);
			return outcome.ok
				? "applied"
				: { status: "failed", errorCode: outcome.code };
		},
		cancelInTransaction(db, job) {
			db.query(
				"UPDATE markdown_workspaces SET save_job_id=NULL,save_state='unknown',save_error='markdown_archive_unknown' WHERE save_job_id=?",
			).run(job.jobId);
		},
		afterCommit: publish,
	};
	return {
		handler,
		enqueue(
			db: Database,
			requestId: string,
			documentId: string,
			revision: number,
			content: { content_json: string; markdown: string | null },
		) {
			const document = required(db, documentId);
			if (
				document.revision !== revision ||
				content.content_json !== document.content_json ||
				content.markdown === null
			)
				throw new Error("revision_conflict");
			if (document.save_job_id) throw new Error("markdown_save_in_progress");
			if (
				document.save_state === "unknown" ||
				document.save_state === "conflict"
			)
				throw new Error(`markdown_archive_${document.save_state}`);
			const binding = archive.binding();
			if (
				!binding ||
				(document.remote_binding && document.remote_binding !== binding)
			)
				throw new Error("markdown_archive_unavailable");
			assertLibraryIdle(db, binding, document.remote_namespace ?? "eumenes");
			const sourceId =
				document.source_id ?? `wiki-${crypto.randomUUID().replaceAll("-", "")}`;
			const namespace = document.remote_namespace ?? "eumenes",
				path = document.remote_path ?? `${document.id}.md`;
			const unchanged = document.content_json === document.saved_content_json;
			const markdown =
				unchanged && document.saved_markdown !== null
					? document.saved_markdown
					: (document.markdown ?? content.markdown);
			const recovery =
				unchanged && document.saved_recovery
					? document.saved_recovery
					: document.content_json;
			const digest = archiveDigest(markdown, recovery);
			db.query(
				`INSERT INTO markdown_saves(id,document_id,title,content_json,markdown,revision,source_id,remote_revision,binding,namespace,path,recovery,content_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(
				requestId,
				document.id,
				document.title,
				document.content_json,
				markdown,
				document.revision,
				sourceId,
				document.remote_revision,
				binding,
				namespace,
				path,
				recovery,
				digest,
			);
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
				"UPDATE markdown_workspaces SET source_id=?,remote_namespace=?,remote_path=?,remote_binding=?,save_job_id=?,save_state='saving',save_error=NULL,conflict_json=NULL WHERE id=?",
			).run(sourceId, namespace, path, binding, job.id, document.id);
			return {
				documentId: document.id,
				revision: document.revision,
				state: "saving",
			};
		},
	};
}
