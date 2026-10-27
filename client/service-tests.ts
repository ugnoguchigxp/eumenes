import {
	serviceCatalogSchema,
	serviceRunSchema,
	serviceRunsSchema,
	uploadedSchema,
	type StartTest,
} from "../api/domains/service-tests/contracts";
import { callJson, json, type Transport } from "./transport";
export function serviceTestsClient(t: Transport) {
	const root = "/api/service-tests";
	return {
		serviceCatalog: async () =>
			callJson(t, serviceCatalogSchema, `${root}/catalog`),
		refreshServiceCatalog: async () =>
			callJson(t, serviceCatalogSchema, `${root}/catalog/refresh`, json({})),
		serviceRuns: async () => callJson(t, serviceRunsSchema, `${root}/runs`),
		startServiceTest: async (input: StartTest) =>
			callJson(t, serviceRunSchema, `${root}/runs`, json(input)),
		diagnoseServices: async () =>
			callJson(t, serviceRunSchema, `${root}/diagnose`, json({})),
		cancelServiceTest: async (id: string) => {
			await t.call(`${root}/runs/${encodeURIComponent(id)}/cancel`, json({}));
		},
		retryServiceArtifact: async (id: string) =>
			callJson(
				t,
				serviceRunSchema,
				`${root}/runs/${encodeURIComponent(id)}/retry-artifact`,
				json({}),
			),
		serviceArtifact: async (id: string, signal?: AbortSignal) =>
			await (
				await t.call(`${root}/runs/${encodeURIComponent(id)}/artifact`, {
					signal,
				})
			).blob(),
		uploadTestAudio: async (file: Blob) =>
			callJson(t, uploadedSchema, `${root}/uploads`, {
				method: "POST",
				body: file,
			}),
	};
}
