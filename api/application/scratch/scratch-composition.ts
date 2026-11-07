import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import type { AttachmentStored } from "../../domains/conversation";
import type { SharedWritePort } from "../../domains/agent-runtime";
import type { SharedFilesPort } from "../../domains/dialogue";
import {
	createScratchStore,
	scratchLimits,
	scratchUri,
	USER_MAKER,
	type ScratchMime,
	type ScratchStore,
} from "../../domains/scratch";
import { jstDisplay } from "../../infrastructure/jst-time";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";

const log = getLogger("scratch");

/** `<dataDir>/scratch`, next to the database like the other data files. */
export const scratchRoot = (dbPath: string) =>
	join(dirname(resolve(dbPath)), "scratch");

/**
 * The upload hook of the conversation (spec §3 「前」): the image as the user sent it becomes a shared file under
 * the attachment's own id, so `eumenes://scratch/<attachmentId>` names it. The attachment stays usable as the
 * model's input when the store refuses it (full disk): that is logged, never a failed upload.
 */
export function attachmentSharing(store: ScratchStore): AttachmentStored {
	return async (attachment, files) => {
		try {
			// A BMP is shared as the image the model reads: the image library and 3D take no BMP.
			const bmp = attachment.originalMime === "image/bmp";
			const data = bmp ? files.normalized : files.original;
			const meta = await sharp(data).metadata();
			await store.put({
				id: attachment.id,
				conversationId: attachment.conversationId,
				name: attachment.name,
				mime: bmp ? attachment.mime : attachment.originalMime,
				data,
				origin: "attached",
				maker: USER_MAKER,
				width: meta.autoOrient?.width ?? meta.width ?? attachment.width,
				height: meta.autoOrient?.height ?? meta.height ?? attachment.height,
				...(attachment.annotation ? { annotation: attachment.annotation } : {}),
			});
		} catch (error) {
			log.warn("scratch.attachment_failed", {
				reason: toErrorCode(error, "scratch_unavailable"),
			});
		}
	};
}

/** A user's text longer than this is also shared as a file (§3): its full words reach an agent by `refs`. */
export const PASTE_CHARS = 2000;

/**
 * The dialogue's shared files (§3・§8.1): an input's attachments that are here, and a long text written as a file
 * under the request's id (a resent request finds the same file).
 */
export function sharedFiles(
	store: ScratchStore,
	now: () => number = Date.now,
): SharedFilesPort {
	return {
		async inputUris({
			requestId,
			conversationId,
			text,
			attachmentIds,
			fileIds,
		}) {
			// Only what the user put into this conversation: an id of another one or of an agent's write is left out.
			const uris = [...attachmentIds, ...fileIds]
				.filter((id) => {
					const item = store.get(id);
					return (
						item?.conversationId === conversationId &&
						item.origin === "attached"
					);
				})
				.map(scratchUri);
			if ([...text].length > PASTE_CHARS) {
				const item = await store.put({
					id: requestId,
					conversationId,
					name: `貼り付けた文章 ${jstDisplay(now()).slice(11, 16)}`,
					mime: "text/plain",
					data: new TextEncoder().encode(text),
					origin: "pasted",
					maker: USER_MAKER,
				});
				uris.push(scratchUri(item.id));
			}
			return uris;
		},
		recentUris: (conversationId, limit) =>
			store
				.list(conversationId)
				.slice(0, limit)
				.map((item) => scratchUri(item.id)),
	};
}

/**
 * The sub-agents' `scratch.write` (§9.1): a text becomes the conversation's shared file, made by the agent's title.
 * A refusal (too large, the store full) is the tool's result the agent reads, never a failed step.
 */
export function sharedWrites(store: ScratchStore): SharedWritePort {
	return {
		async write(input, context) {
			const data = new TextEncoder().encode(input.text);
			if (data.length > scratchLimits.writeBytes)
				return { ok: false, code: "scratch_too_large" };
			try {
				const item = await store.put({
					conversationId: context.conversationId,
					name: input.name,
					mime: input.mime as ScratchMime,
					data,
					origin: "written",
					maker: context.maker,
				});
				return { ok: true, uri: scratchUri(item.id), bytes: item.bytes };
			} catch (error) {
				return { ok: false, code: toErrorCode(error, "scratch_unavailable") };
			}
		},
	};
}

export function buildScratch(dbPath: string) {
	const store = createScratchStore({ root: scratchRoot(dbPath) });
	return { store, attachmentStored: attachmentSharing(store) };
}
