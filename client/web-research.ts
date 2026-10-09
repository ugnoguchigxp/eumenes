import type {
	CacheStatus,
	ResearchSubmit,
	ResearchRun,
} from "../api/domains/web-research/contracts";
import { json, type Transport } from "./transport";
function requestSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(5000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function webResearchClient(t: Transport) {
	return {
		submitResearch: async (
			input: ResearchSubmit,
			signal?: AbortSignal,
		): Promise<ResearchRun> =>
			(
				await t.call("/api/web-research/runs", {
					...json(input),
					signal: requestSignal(signal),
				})
			).json(),
		researchRun: async (
			id: string,
			signal?: AbortSignal,
		): Promise<ResearchRun> =>
			(
				await t.call(`/api/web-research/runs/${encodeURIComponent(id)}`, {
					signal: requestSignal(signal),
				})
			).json(),
		cancelResearch: async (
			id: string,
			signal?: AbortSignal,
		): Promise<ResearchRun> =>
			(
				await t.call(
					`/api/web-research/runs/${encodeURIComponent(id)}/cancel`,
					{ ...json({}), signal: requestSignal(signal) },
				)
			).json(),
		researchCacheStatus: async (signal?: AbortSignal): Promise<CacheStatus> =>
			(
				await t.call("/api/web-research/cache/status", {
					signal: requestSignal(signal),
				})
			).json(),
		clearResearchCache: async (
			signal?: AbortSignal,
		): Promise<{ cleared: boolean }> =>
			(
				await t.call("/api/web-research/cache/clear", {
					...json({}),
					signal: requestSignal(signal),
				})
			).json(),
	};
}
