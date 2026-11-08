import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import {
	applyInput,
	newInput,
	saveInput,
	type ArchivePort,
} from "../contracts";
import { row, session, list } from "../repository";
import { view, create, apply, replay, sessionAdapter } from "./workspace";
import { createArchiveSave } from "./archive-save";
import { createArchiveRecovery } from "./archive-recovery";
import { createArchiveLibrary } from "./archive-library";
import { createLibraryManagement } from "./library-management";
import { createGeneratedDocuments } from "./generated";
import { staged, stageDocument } from "./inputs";

export function createMarkdown(deps: {
	store: SqliteStore;
	queue: QueueService;
	archive: ArchivePort;
	publish?: () => void;
}) {
	const { store, queue, archive } = deps;
	const saves = createArchiveSave(archive, queue, deps.publish);
	queue.registerHandler(saves.handler);
	return {
		generated: createGeneratedDocuments(store, queue, archive, deps.publish),
		...createLibraryManagement(store, archive, deps.publish),
		available: archive.available,
		stage: stageDocument(store),
		listInTransaction: list,
		viewInTransaction: view,
		session: sessionAdapter(),
		currentInTransaction(db: Database, targetRef?: string, workRef?: string) {
			const work = workRef ? session(db, workRef) : null,
				selected = targetRef ?? work?.document_id;
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
				if (operation === "markdown.new" || operation === "markdown.new.v2") {
					const input = newInput.parse(raw),
						source = staged(db, input.stageId);
					const document = create(
						db,
						input.title,
						JSON.parse(source.content_json),
						source.markdown,
					);
					db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
					return {
						documentId: document.id,
						revision: document.revision,
						state: "draft",
					};
				}
				if (
					operation === "markdown.apply" ||
					operation === "markdown.apply.v2"
				) {
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
					source = staged(db, input.stageId);
				const result = saves.enqueue(
					db,
					requestId,
					input.documentId,
					input.expectedRevision,
					source,
				);
				db.query("DELETE FROM markdown_inputs WHERE id=?").run(input.stageId);
				return result;
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
		...createArchiveLibrary(store, archive),
		reconcile: createArchiveRecovery(store, archive),
		afterCommit: () => {
			queue.wake();
			deps.publish?.();
		},
	};
}
export type MarkdownService = ReturnType<typeof createMarkdown>;
