import type {
	ClearResponse,
	EditResponse,
	ListResponse,
	RouteDTO,
} from "../api/domains/research-routes/contracts";
import { json, type Transport } from "./transport";
function requestSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(10_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function researchRoutesClient(t: Transport) {
	const post = async <T>(path: string, body: unknown, signal?: AbortSignal) =>
		(
			await t.call(path, { ...json(body), signal: requestSignal(signal) })
		).json() as Promise<T>;
	const keyPath = (key: string) =>
		`/api/research-routes/${encodeURIComponent(key)}`;
	return {
		researchRoutes: async (
			query: { cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		): Promise<ListResponse> => {
			const params = new URLSearchParams();
			if (query.cursor) params.set("cursor", query.cursor);
			if (query.limit !== undefined) params.set("limit", String(query.limit));
			const suffix = params.size ? `?${params}` : "";
			return (
				await t.call(`/api/research-routes${suffix}`, {
					signal: requestSignal(signal),
				})
			).json();
		},
		researchRoute: async (
			key: string,
			signal?: AbortSignal,
		): Promise<RouteDTO> =>
			(await t.call(keyPath(key), { signal: requestSignal(signal) })).json(),
		editResearchRoute: (
			key: string,
			input: {
				requestId: string;
				expectedStateToken: string;
				instruction: string;
			},
			signal?: AbortSignal,
		) => post<EditResponse>(`${keyPath(key)}/edits`, input, signal),
		disableResearchRoute: (
			key: string,
			input: { requestId: string; expectedStateToken: string },
			signal?: AbortSignal,
		) => post<RouteDTO>(`${keyPath(key)}/disable`, input, signal),
		rediscoverResearchRoute: (
			key: string,
			input: { requestId: string; expectedStateToken: string },
			signal?: AbortSignal,
		) => post<RouteDTO>(`${keyPath(key)}/rediscover`, input, signal),
		clearResearchRoutes: (
			input: { requestId: string; expectedEpoch: number },
			signal?: AbortSignal,
		) => post<ClearResponse>("/api/research-routes/clear", input, signal),
	};
}
