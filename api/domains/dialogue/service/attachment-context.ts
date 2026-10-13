import type { Tx } from "../../queue";
import type { DialogueDeps, GenerateInput } from "./context";

/** Resolve only in the execution phase; prepared state and queue payloads hold metadata. */
export function resolveAttachmentContext(
	deps: DialogueDeps,
	input: GenerateInput,
	conversationId: string,
) {
	if (!input.messages.some((m) => m.attachments?.length)) return;
	input.messages = deps.store.read((db) =>
		input.messages.map((m) => {
			if (
				m.attachments?.length &&
				(!m.sourceMessageId ||
					!deps.conversation.validateAttachmentsInTransaction(
						db,
						m.sourceMessageId,
						m.attachments,
					))
			)
				throw new Error("attachment_source_unavailable");
			return {
				...m,
				...(m.attachments?.length
					? {
							images: deps.conversation.resolveAttachmentsInTransaction(
								db,
								conversationId,
								m.attachments,
							),
						}
					: {}),
			};
		}),
	);
}

export function validAttachmentContext(
	deps: DialogueDeps,
	db: Tx,
	input: GenerateInput,
	conversationId: string,
) {
	return (
		input.messages.every(
			(m) =>
				!m.attachments?.length ||
				(!!m.sourceMessageId &&
					deps.conversation.validateAttachmentsInTransaction(
						db,
						m.sourceMessageId,
						m.attachments,
					)),
		) &&
		deps.conversation.validAttachmentSourcesInTransaction(
			db,
			conversationId,
			input.messages.flatMap((m) => m.attachments ?? []),
		)
	);
}
