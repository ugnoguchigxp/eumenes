import type {
	ConversationResourcesResponse,
	ResolveResourceResponse,
	SearchResourcesResponse,
} from "../../../../api/domains/resources/contracts";
import type { EumenesClient } from "../../../../client";
import {
	ApiError,
	createTransport,
	type Transport,
} from "../../../../client/transport";

/** The refusals a resolve answers with a status code instead of `{ ok: false }`. */
const NOT_FOUND_STATUS = new Set([400, 404]);

type ResourceSearchParams = {
	query?: string;
	kind?: string;
	since?: string;
	until?: string;
	limit?: number;
};

function resourcesApi(t: Transport) {
	const read = async <T>(path: string, init?: RequestInit): Promise<T> =>
		(await (await t.call(path, init)).json()) as T;
	return {
		/** A refused resolve (unknown, deleted, invalid) is a value; a failed request throws. */
		resolve: async (
			uri: string,
			signal?: AbortSignal,
		): Promise<ResolveResourceResponse> => {
			try {
				return await read<ResolveResourceResponse>(
					`/api/resources/resolve?uri=${encodeURIComponent(uri)}`,
					{ signal },
				);
			} catch (error) {
				if (error instanceof ApiError && NOT_FOUND_STATUS.has(error.status)) {
					const code = (error.body as { code?: string } | undefined)?.code;
					return {
						ok: false,
						code:
							code === "resource_uri_invalid" ||
							code === "resource_kind_unknown" ||
							code === "action_not_allowed"
								? code
								: "item_not_found",
					};
				}
				throw error;
			}
		},
		search: (params: ResourceSearchParams = {}, signal?: AbortSignal) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(params))
				if (value !== undefined && value !== "") query.set(key, String(value));
			const text = query.toString();
			return read<SearchResourcesResponse>(
				`/api/resources${text ? `?${text}` : ""}`,
				{ signal },
			);
		},
		conversationResources: (conversationId: string, signal?: AbortSignal) =>
			read<ConversationResourcesResponse>(
				`/api/conversations/${encodeURIComponent(conversationId)}/resources`,
				{ signal },
			),
	};
}
type ResourcesApi = ReturnType<typeof resourcesApi>;

const apis = new WeakMap<EumenesClient, ResourcesApi>();
/**
 * The resource endpoints for the app's client. The client carries no credential of its own
 * (the host proxy adds it), so the same origin transport reaches the same API.
 */
export function resourcesApiFor(client: EumenesClient): ResourcesApi {
	let api = apis.get(client);
	if (!api) {
		api = resourcesApi(createTransport(client.identity));
		apis.set(client, api);
	}
	return api;
}
