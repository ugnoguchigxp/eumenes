import type { Database } from "bun:sqlite";
import { jstDay } from "../../../infrastructure/jst-time";
import { sha256Hex } from "../../../infrastructure/digest";
import { toErrorCode } from "../../../infrastructure/error-code";
import { rowOf, save, stateOf, type RunRow } from "../repository";
import { current, type Context } from "./context";
import { notice } from "./lifecycle";

/** Filename constraints only: title and document structure are chosen by the model. */
export function documentName(title: string) {
	return [...title]
		.map((c) => {
			const code = c.codePointAt(0)!;
			return code < 32 || code === 127 || c === "/" || c === "\\" ? "_" : c;
		})
		.slice(0, 80)
		.join("")
		.trim();
}
export function publishDocument(
	ctx: Context,
	db: Database,
	row: RunRow,
): boolean {
	const state = stateOf(row);
	if (
		!state.saveDocument ||
		!["completed", "partial"].includes(row.state) ||
		!state.result ||
		!state.draft?.title
	)
		return false;
	const id = ctx.id(),
		outcome = row.state as "completed" | "partial";
	const input = {
		id,
		ownerRef: `${row.id}:${row.epoch}`,
		conversationId: row.conversation_id,
		sourceRunId: state.source.runId,
		title: state.draft.title,
		markdown: state.draft.answer,
		namespace: "eumenes",
		path: `research/${jstDay(ctx.now())}_${documentName(state.draft.title)}_${id}.md`,
	};
	if (!ctx.documents) {
		state.result.document = {
			id,
			title: input.title,
			path: input.path,
			local: { state: "failed", code: "scratch_unavailable" },
			archive: { state: "unsaved", code: "markdown_archive_unavailable" },
		};
		save(db, row, state, ctx.now());
		return false;
	}
	state.documentIds = [...(state.documentIds ?? []), id];
	state.publication = { id, outcome, result: state.result };
	state.result = null;
	row.state = "waiting_child";
	save(db, row, state, ctx.now());
	try {
		ctx.documents.startInTransaction(db, input);
		return true;
	} catch (e) {
		row.state = outcome;
		state.result = {
			...state.publication.result,
			document: {
				id,
				title: input.title,
				path: input.path,
				local: { state: "failed", code: "scratch_not_written" },
				archive: {
					state: "unsaved",
					code: toErrorCode(e, "markdown_archive_unavailable"),
				},
			},
		};
		delete state.publication;
		save(db, row, state, ctx.now());
		return false;
	}
}
export function collectDocuments(ctx: Context, db: Database) {
	const rows = db
		.query(
			"SELECT id FROM pursuit_runs WHERE state IN ('waiting_child','completed','partial') AND json_extract(data_json,'$.publication.id') IS NOT NULL",
		)
		.all() as { id: string }[];
	for (const candidate of rows) {
		const row = rowOf(db, candidate.id)!;
		try {
			current(ctx, db, row.id, row.epoch, true);
		} catch {
			ctx.forget(db, row.id);
			continue;
		}
		const state = stateOf(row),
			publication = state.publication!;
		const receipt = ctx.documents?.currentInTransaction(db, publication.id);
		if (receipt?.state === "pending") continue;
		const waiting = row.state === "waiting_child";
		row.state = publication.outcome;
		const document = receipt
			? {
					id: receipt.id,
					title: receipt.title,
					path: receipt.path,
					local: receipt.local,
					archive: receipt.archive,
				}
			: undefined;
		if (
			!waiting &&
			sha256Hex(JSON.stringify(state.result?.document)) ===
				sha256Hex(JSON.stringify(document))
		)
			continue;
		state.result = {
			...publication.result,
			...(document
				? {
						document,
						links: [
							...(document.local.uri ? [document.local.uri] : []),
							...(document.archive.state === "saved"
								? [
										`eumenes://markdown.document/${encodeURIComponent(`generated-${document.id}`)}`,
									]
								: []),
						],
					}
				: { code: "markdown_document_missing" }),
		};
		// Retain the publication identity for subsequent forgetting; it never starts a second save.
		save(db, row, state, ctx.now());
		if (waiting) notice(ctx, db, row);
	}
}
