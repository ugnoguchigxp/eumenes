import {
	bookmarkHistorySchema,
	bookmarkListSchema,
	bookmarkSchema,
	bookmarkSourceSchema,
	type CreateBookmarkRequest,
	type DeactivateBookmarkRequest,
	type ReviseBookmarkRequest,
} from "../api/domains/continuity/contracts";
import { json, type Transport } from "./transport";
export function continuityClient(transport: Transport) {
	const segment = (value: string) => {
		// URL normalization would turn dot segments into a different route.
		if (value === "." || value === "..")
			throw new Error("invalid_path_segment");
		return encodeURIComponent(value);
	};
	const base = (conversationId: string) =>
		`/api/conversations/${segment(conversationId)}/bookmarks`;
	const item = (conversationId: string, bookmarkId: string) =>
		`${base(conversationId)}/${segment(bookmarkId)}`;
	return {
		identity: transport.identity,
		list: async (
			conversationId: string,
			options: { includeInactive?: boolean } = {},
			signal?: AbortSignal,
		) =>
			bookmarkListSchema.parse(
				await (
					await transport.call(
						`${base(conversationId)}${options.includeInactive ? "?includeInactive=true" : ""}`,
						{ signal },
					)
				).json(),
			),
		create: async (conversationId: string, request: CreateBookmarkRequest) =>
			bookmarkSchema.parse(
				await (
					await transport.call(base(conversationId), json(request))
				).json(),
			),
		revise: async (
			conversationId: string,
			bookmarkId: string,
			request: ReviseBookmarkRequest,
		) =>
			bookmarkSchema.parse(
				await (
					await transport.call(
						`${item(conversationId, bookmarkId)}/revise`,
						json(request),
					)
				).json(),
			),
		deactivate: async (
			conversationId: string,
			bookmarkId: string,
			request: DeactivateBookmarkRequest,
		) =>
			bookmarkSchema.parse(
				await (
					await transport.call(
						`${item(conversationId, bookmarkId)}/deactivate`,
						json(request),
					)
				).json(),
			),
		history: async (
			conversationId: string,
			bookmarkId: string,
			options: { after?: number; limit?: number } = {},
			signal?: AbortSignal,
		) => {
			const query = new URLSearchParams();
			if (options.after !== undefined)
				query.set("after", String(options.after));
			if (options.limit !== undefined)
				query.set("limit", String(options.limit));
			const suffix = query.size ? `?${query}` : "";
			return bookmarkHistorySchema.parse(
				await (
					await transport.call(
						`${item(conversationId, bookmarkId)}/history${suffix}`,
						{ signal },
					)
				).json(),
			);
		},
		source: async (
			conversationId: string,
			bookmarkId: string,
			signal?: AbortSignal,
		) =>
			bookmarkSourceSchema.parse(
				await (
					await transport.call(`${item(conversationId, bookmarkId)}/source`, {
						signal,
					})
				).json(),
			),
	};
}
export type ContinuityClient = ReturnType<typeof continuityClient>;
