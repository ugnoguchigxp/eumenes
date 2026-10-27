import {
	conversationSchema,
	attachmentSchema,
	historySearchResultSchema,
	historyReadResultSchema,
	type HistorySearchInput,
	type HistoryReadInput,
} from "../api/domains/conversation/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";
export function conversationClient(transport: Transport) {
	return {
		uploadAttachment: async (id: string, requestId: string, file: File) => {
			const body = new FormData();
			body.set("file", file);
			return callJson(
				transport,
				attachmentSchema,
				withQuery(`/api/conversations/${encodeURIComponent(id)}/attachments`, {
					requestId,
				}),
				{ method: "POST", body },
			);
		},
		attachmentPreview: async (
			id: string,
			attachmentId: string,
			signal?: AbortSignal,
		) =>
			(
				await transport.call(
					withQuery(
						`/api/conversations/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/content`,
						{ preview: true },
					),
					{ signal },
				)
			).blob(),
		historySearch: async (
			id: string,
			input: HistorySearchInput,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				historySearchResultSchema,
				`/api/conversations/${encodeURIComponent(id)}/history/search`,
				{ ...json(input), signal },
			),
		historyRead: async (
			id: string,
			input: HistoryReadInput,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				historyReadResultSchema,
				`/api/conversations/${encodeURIComponent(id)}/history/read`,
				{ ...json(input), signal },
			),
		identity: transport.identity,
		conversation: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				conversationSchema,
				`/api/conversations/${encodeURIComponent(id)}`,
				{ signal },
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
