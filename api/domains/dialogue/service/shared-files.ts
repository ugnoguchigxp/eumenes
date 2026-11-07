import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { toErrorCode } from "../../../infrastructure/error-code";
import type { ConversationResource } from "../contracts/resources";
import type { DialogueDeps } from "./context";
import { lineText } from "./input-text";
import { resourceName } from "./resource-ledger";

const log = getLogger("dialogue");

/** The most `共有中` lines of `## State` (spec/server-scratch-cache-design-2026-11-07.md §8.1). */
export const SHARED_LINES = 6;

/**
 * The input's shared files, written before its transaction (§3 「前」). A store that cannot take them leaves the
 * input as it is: the message is still accepted, only without their numbers.
 */
export async function sharedInputUris(
	deps: Pick<DialogueDeps, "sharedFiles">,
	input: {
		requestId: string;
		conversationId: string;
		text: string;
		attachmentIds?: string[];
		fileIds?: string[];
	},
): Promise<string[] | undefined> {
	if (!deps.sharedFiles) return undefined;
	try {
		return await deps.sharedFiles.inputUris({
			requestId: input.requestId,
			conversationId: input.conversationId,
			text: input.text,
			attachmentIds: input.attachmentIds ?? [],
			fileIds: input.fileIds ?? [],
		});
	} catch (error) {
		log.warn("dialogue.shared_files_failed", {
			requestId: input.requestId,
			reason: toErrorCode(error, "shared_files_unavailable"),
		});
		return undefined;
	}
}

/** Enters the input's shared files into the ledger as `attached` and links them to its message (§6.1). */
export function enterSharedInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	conversationId: string,
	messageId: string,
	uris: readonly string[],
) {
	const { resources, resourceLedger: ledger } = deps;
	if (!resources || !ledger || !uris.length) return;
	const ids: string[] = [];
	for (const uri of uris) {
		const resolved = resources.registry.resolveInTransaction(db, uri);
		if (!resolved.ok) continue;
		const row = ledger.enterInTransaction(db, {
			conversationId,
			uri: resolved.resource.uri,
			kind: resolved.resource.kind,
			label: resolved.resource.label,
			source: "attached",
		});
		if (!row.forgottenAt && !ids.includes(row.id)) ids.push(row.id);
	}
	if (ids.length) ledger.linkMessageInTransaction(db, messageId, ids);
}

/** `a7「IMG_2041.jpg」（利用者が添付、画像 1600×1200）`; null when the resource is gone. */
function sharedLine(
	deps: Pick<DialogueDeps, "resources">,
	db: Database,
	row: ConversationResource,
) {
	const resolved = deps.resources?.registry.resolveInTransaction(db, row.uri);
	if (!resolved?.ok) return null;
	const note = resolved.resource.note;
	return `- ${resourceName(row.ref)}「${lineText(row.label)}」${note ? `（${lineText(note)}）` : ""}`;
}

/** The `提示中` lines of the input's own shared files, the ones still there. Adds their URIs to `shown`. */
export function attachedLinesInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	inputMessageId: string,
	shown: Set<string>,
): string[] {
	const lines: string[] = [];
	for (const row of deps.resourceLedger?.ofMessageInTransaction(
		db,
		inputMessageId,
	) ?? []) {
		if (row.source !== "attached" || shown.has(row.uri)) continue;
		const line = sharedLine(deps, db, row);
		if (!line) continue;
		shown.add(row.uri);
		lines.push(line);
	}
	return lines;
}

/** The `共有中` lines: the conversation's recent shared files that have a number and are not presented. */
export function sharedLinesInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger" | "sharedFiles">,
	db: Database,
	conversationId: string,
	shown: ReadonlySet<string>,
): string[] {
	const { sharedFiles, resourceLedger: ledger } = deps;
	if (!sharedFiles || !ledger) return [];
	const lines: string[] = [];
	// Recent files without a number (an attachment never sent, a write no TODO returned) are passed over.
	for (const uri of sharedFiles.recentUris(conversationId, 50)) {
		if (lines.length >= SHARED_LINES) break;
		if (shown.has(uri)) continue;
		const row = ledger.byUriInTransaction(db, conversationId, uri);
		if (!row || row.forgottenAt) continue;
		const line = sharedLine(deps, db, row);
		if (line) lines.push(line);
	}
	return lines;
}
