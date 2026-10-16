import {
	conversationSchema,
	attachmentSchema,
	historySearchResultSchema,
	historyReadResultSchema,
	type HistorySearchInput,
	type HistoryReadInput,
} from "../api/domains/conversation/contracts";
import { json, type Transport } from "./transport";
export function conversationClient(transport: Transport) {
	return {
		uploadAttachment: async (id: string, requestId: string, file: File) => {
			const body = new FormData();
			body.set("file", file);
			return attachmentSchema.parse(
				await (
					await transport.call(
						`/api/conversations/${encodeURIComponent(id)}/attachments?requestId=${encodeURIComponent(requestId)}`,
						{ method: "POST", body },
					)
				).json(),
			);
		},
		attachmentPreview: async (
			id: string,
			attachmentId: string,
			signal?: AbortSignal,
		) =>
			(
				await transport.call(
					`/api/conversations/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/content?preview=true`,
					{ signal },
				)
			).blob(),
		historySearch: async (
			id: string,
			input: HistorySearchInput,
			signal?: AbortSignal,
		) =>
			historySearchResultSchema.parse(
				await (
					await transport.call(
						`/api/conversations/${encodeURIComponent(id)}/history/search`,
						{ ...json(input), signal },
					)
				).json(),
			),
		historyRead: async (
			id: string,
			input: HistoryReadInput,
			signal?: AbortSignal,
		) =>
			historyReadResultSchema.parse(
				await (
					await transport.call(
						`/api/conversations/${encodeURIComponent(id)}/history/read`,
						{ ...json(input), signal },
					)
				).json(),
			),
		identity: transport.identity,
		conversation: async (id: string, signal?: AbortSignal) =>
			conversationSchema.parse(
				await (
					await transport.call(`/api/conversations/${encodeURIComponent(id)}`, {
						signal,
					})
				).json(),
			),
	};
}
export type ConversationClient = Pick<
	ReturnType<typeof conversationClient>,
	"identity" | "conversation"
>;

export type {
	HistoryView,
	HistoryScope,
} from "../api/domains/conversation/contracts";
