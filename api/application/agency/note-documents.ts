import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { documentName } from "../../infrastructure/markdown-filename";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { ConversationResourcePort } from "../../domains/dialogue";
import type { MarkdownService } from "../../domains/markdown";
import { formatResourceUri } from "../../domains/resources";
import { scratchUri, type ScratchStore } from "../../domains/scratch";
import type { NoteDocumentPort } from "./host-types";

const log = getLogger("agency");
const OWNER = "agency-note";

/** The document of a note: the same note is the same document (a UUID made of the conversation and the note). */
function documentId(conversationId: string, noteId: string) {
	const hex = sha256Hex(`${OWNER}:${conversationId}:${noteId}`);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`8${hex.slice(13, 16)}`,
		`8${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
}

/** The day a note is filed under, as the user reads the calendar (Japan time): `2026-11-12`. */
const dayOf = (at: number) =>
	new Date(at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

/**
 * The agency's research notes as documents of the Markdown domain (its generated documents, as the deep web research
 * saves its report): a local Markdown file, and the document library when it is connected. Every note is saved as it
 * arrives, so the library keeps the notes the agent's own list lets go; a note is shown through the document's
 * screen, never as text of the agency's own making.
 */
export function createNoteDocuments(options: {
	store: Pick<SqliteStore, "write">;
	markdown: MarkdownService;
	scratch?: ScratchStore;
	ledger(): ConversationResourcePort | undefined;
}): NoteDocumentPort {
	const { store, markdown, scratch } = options;
	const { generated } = markdown;
	/** The documents this run of the server started (their local files live as long). */
	const started = new Set<string>();
	const forgotten = new Set<string>();
	const hasLocal = (id: string) => !forgotten.has(id) && !!scratch?.get(id);
	const forgetLocal = (id: string) => {
		const item = scratch?.get(id);
		if (item) scratch?.forgetWritten(id, item.conversationId);
	};
	generated.configureOwner(OWNER, {
		// A note the agent's list let go is still saved; only a forgotten one is not.
		validInTransaction: (_db, id) => started.has(id) && !forgotten.has(id),
		async writeLocal(input, signal) {
			signal.throwIfAborted();
			if (!scratch) throw new Error("scratch_unavailable");
			const item = await scratch.put({
				id: input.id,
				conversationId: input.conversationId,
				name: `${documentName(input.title) || "調べもののメモ"}.md`,
				mime: "text/markdown",
				data: new TextEncoder().encode(input.markdown),
				origin: "written",
				maker: "調べもの",
				internal: true,
			});
			return scratchUri(item.id);
		},
		hasLocal,
		forgetLocal,
	});
	return {
		startInTransaction(db, note) {
			const id = documentId(note.conversationId, note.noteId);
			const old = generated.currentInTransaction(db, id);
			if (old) {
				const usable =
					old.state === "pending" ||
					(old.state === "settled" &&
						(old.archive.state === "saved" || old.local.state === "saved"));
				// A document whose local file went with an earlier run of the server, and that was never sent to the
				// library, is made again. One whose sending is unknown is not (no second PUT).
				if (usable || old.archive.state !== "unsaved") return id;
				generated.cancelInTransaction(db, id, true);
			}
			started.add(id);
			forgotten.delete(id);
			generated.startInTransaction(db, {
				id,
				ownerRef: `${OWNER}:${note.conversationId}:${note.noteId}`,
				sourceRunId: `${OWNER}:${note.noteId}`,
				conversationId: note.conversationId,
				title: note.title,
				markdown: note.markdown,
				namespace: "eumenes",
				path: `notes/${dayOf(note.at)}_${documentName(note.title) || "調べもののメモ"}_${note.noteId}.md`,
			});
			return id;
		},
		stateInTransaction(db, id) {
			const receipt = generated.currentInTransaction(db, id);
			if (!receipt) return { code: "markdown_not_found" };
			if (receipt.state === "pending") return "pending";
			if (receipt.state === "cancelled")
				return { code: "markdown_source_invalid" };
			return receipt.archive.state === "saved" ||
				receipt.local.state === "saved"
				? {
						uri: formatResourceUri("markdown.document", `generated-${id}`),
						label: receipt.title,
					}
				: {
						code:
							receipt.local.code ??
							receipt.archive.code ??
							"markdown_not_saved",
					};
		},
		linkInTransaction(db, input) {
			const ledger = options.ledger();
			if (!ledger) throw new Error("resources_unavailable");
			const resource = ledger.enterInTransaction(db, {
				conversationId: input.conversationId,
				uri: input.uri,
				kind: "markdown.document",
				label: input.label,
				source: "found",
			});
			ledger.linkMessageInTransaction(db, input.messageId, [resource.id]);
		},
		forget(conversationId, noteIds) {
			for (const noteId of noteIds) {
				const id = documentId(conversationId, noteId);
				forgotten.add(id);
				started.delete(id);
				forgetLocal(id);
				// The document saved in the library stays the user's (as a research report does); its record here goes.
				void store
					.write((db: Database) => generated.cancelInTransaction(db, id, true))
					.catch((error: unknown) =>
						log.warn("agency.note_document_forget_failed", {
							reason: toErrorCode(error, "note_document_forget_failed"),
						}),
					);
			}
		},
	};
}
