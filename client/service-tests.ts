import type {
	ServiceCatalog,
	ServiceRun,
	StartTest,
} from "../api/domains/service-tests/contracts";
import { json, type Transport } from "./transport";
export function serviceTestsClient(t: Transport) {
	const root = "/api/service-tests";
	return {
		serviceCatalog: async () =>
			(await (await t.call(`${root}/catalog`)).json()) as ServiceCatalog,
		refreshServiceCatalog: async () =>
			(await (
				await t.call(`${root}/catalog/refresh`, json({}))
			).json()) as ServiceCatalog,
		serviceRuns: async () =>
			(await (await t.call(`${root}/runs`)).json()) as ServiceRun[],
		startServiceTest: async (input: StartTest) =>
			(await (await t.call(`${root}/runs`, json(input))).json()) as ServiceRun,
		diagnoseServices: async () =>
			(await (await t.call(`${root}/diagnose`, json({}))).json()) as ServiceRun,
		cancelServiceTest: async (id: string) => {
			await t.call(`${root}/runs/${encodeURIComponent(id)}/cancel`, json({}));
		},
		retryServiceArtifact: async (id: string) =>
			(await (
				await t.call(
					`${root}/runs/${encodeURIComponent(id)}/retry-artifact`,
					json({}),
				)
			).json()) as ServiceRun,
		serviceArtifact: async (id: string, signal?: AbortSignal) =>
			await (
				await t.call(`${root}/runs/${encodeURIComponent(id)}/artifact`, {
					signal,
				})
			).blob(),
		uploadTestAudio: async (file: Blob) =>
			(await (
				await t.call(`${root}/uploads`, { method: "POST", body: file })
			).json()) as { id: string },
	};
}
