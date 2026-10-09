import { json, type Transport } from "./transport";
export function attitudeDatasetClient(t: Transport) {
	const root = "/api/attitude-dataset";
	return {
		attitudeStatus: async () => (await t.call(`${root}/status`)).json(),
		attitudeStart: async () => (await t.call(`${root}/start`, json({}))).json(),
		attitudeStop: async () => (await t.call(`${root}/stop`, json({}))).json(),
		attitudeSamples: async () => (await t.call(`${root}/samples`)).json(),
		attitudeSample: async (id: string, showPredictions = false) =>
			(
				await t.call(
					`${root}/samples/${encodeURIComponent(id)}${showPredictions ? "?predictions=show" : ""}`,
				)
			).json(),
		attitudeReview: async (id: string, review: unknown) =>
			(
				await t.call(
					`${root}/samples/${encodeURIComponent(id)}/review`,
					json(review),
				)
			).json(),
		attitudeReport: async () => (await t.call(`${root}/report`)).json(),
		attitudeSplit: async () => (await t.call(`${root}/split`, json({}))).json(),
		attitudeExport: async () =>
			(await t.call(`${root}/export`)).json() as Promise<{
				jsonl: string;
				partitions: Record<"train" | "calibration" | "eval", string>;
				report: unknown;
				schema: unknown;
			}>,
	};
}
