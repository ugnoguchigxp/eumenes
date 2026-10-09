import {
	serviceCatalogSchema,
	serviceRunSchema,
	serviceRunsSchema,
	uploadedSchema,
	type StartTest,
} from "../api/domains/service-tests/contracts";
import { json, type Transport } from "./transport";
export function serviceTestsClient(t: Transport) {
	const root = "/api/service-tests";
	return {
		serviceCatalog: async () =>
			serviceCatalogSchema.parse(
				await (await t.call(`${root}/catalog`)).json(),
			),
		refreshServiceCatalog: async () =>
			serviceCatalogSchema.parse(
				await (await t.call(`${root}/catalog/refresh`, json({}))).json(),
			),
		serviceRuns: async () =>
			serviceRunsSchema.parse(await (await t.call(`${root}/runs`)).json()),
		startServiceTest: async (input: StartTest) =>
			serviceRunSchema.parse(
				await (await t.call(`${root}/runs`, json(input))).json(),
			),
		diagnoseServices: async () =>
			serviceRunSchema.parse(
				await (await t.call(`${root}/diagnose`, json({}))).json(),
			),
		cancelServiceTest: async (id: string) => {
			await t.call(`${root}/runs/${encodeURIComponent(id)}/cancel`, json({}));
		},
		retryServiceArtifact: async (id: string) =>
			serviceRunSchema.parse(
				await (
					await t.call(
						`${root}/runs/${encodeURIComponent(id)}/retry-artifact`,
						json({}),
					)
				).json(),
			),
		serviceArtifact: async (id: string, signal?: AbortSignal) =>
			await (
				await t.call(`${root}/runs/${encodeURIComponent(id)}/artifact`, {
					signal,
				})
			).blob(),
		uploadTestAudio: async (file: Blob) =>
			uploadedSchema.parse(
				await (
					await t.call(`${root}/uploads`, { method: "POST", body: file })
				).json(),
			),
	};
}
