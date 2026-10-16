import {
	excalidrawConnectionInput,
	excalidrawConnectionSchema,
	type ExcalidrawConnectionInput,
} from "../api/domains/settings/contracts";
import { ttsVoicesSchema } from "../api/domains/larm/contracts";
import {
	connectionModelsSchema,
	larmDetailsSchema,
	larmProfilesSchema,
	probeSchema,
	startedProbeSchema,
	usageSchema,
	type UsagePageQuery,
} from "../api/domains/inference/contracts";
import {
	diagnosticsSchema,
	settingsSchema,
	type ApplySettings,
} from "../api/domains/settings/contracts";
import { json, type Transport } from "./transport";
export type {
	ConnectionModels,
	LarmDetails,
	LarmProfiles,
	Usage,
	Probe,
} from "../api/domains/inference/contracts";
export type { Diagnostics } from "../api/domains/settings/contracts";

export function settingsClient(t: Transport) {
	return {
		excalidrawConnection: async () =>
			excalidrawConnectionSchema.parse(
				await (await t.call("/api/settings/excalidraw")).json(),
			),
		configureExcalidraw: async (input: ExcalidrawConnectionInput) =>
			excalidrawConnectionSchema.parse(
				await (
					await t.call("/api/settings/excalidraw", {
						...json(excalidrawConnectionInput.parse(input)),
						method: "PUT",
					})
				).json(),
			),
		larmVoices: async (signal?: AbortSignal, language?: "ja" | "en") =>
			ttsVoicesSchema.parse(
				await (
					await t.call(
						`/api/inference/voices${language ? `?language=${language}` : ""}`,
						{ signal },
					)
				).json(),
			),
		settings: async () =>
			settingsSchema.parse(await (await t.call("/api/settings")).json()),
		applySettings: async (input: ApplySettings) =>
			settingsSchema.parse(
				await (await t.call("/api/settings/apply", json(input))).json(),
			),
		connectionModels: async (
			connectionId: string,
			signal?: AbortSignal,
			refresh = false,
		) =>
			connectionModelsSchema.parse(
				await (
					await t.call(
						`/api/inference/connections/${encodeURIComponent(connectionId)}/models${refresh ? "?refresh=1" : ""}`,
						{ signal },
					)
				).json(),
			),
		settingsDiagnostics: async () =>
			diagnosticsSchema.parse(
				await (await t.call("/api/settings/diagnostics")).json(),
			),
		inferenceUsage: async () =>
			usageSchema
				.array()
				.parse(await (await t.call("/api/inference/usage")).json()),
		inferenceUsagePage: async (query: UsagePageQuery, signal?: AbortSignal) => {
			const params = new URLSearchParams(
				Object.entries(query).map(([key, value]) => [key, String(value)]),
			);
			const page = (await (
				await t.call("/api/inference/usage/page?" + params, { signal })
			).json()) as {
				items: unknown[];
				total: number;
				pageIndex: number;
				pageSize: number;
			};
			return { ...page, items: usageSchema.array().parse(page.items) };
		},
		larmDetails: async () =>
			larmDetailsSchema.parse(
				await (await t.call("/api/inference/larm")).json(),
			),
		larmProfiles: async () =>
			larmProfilesSchema.parse(
				await (await t.call("/api/inference/larm/profiles")).json(),
			),
		inferenceProbes: async () =>
			probeSchema
				.array()
				.parse(await (await t.call("/api/inference/probes")).json()),
		startProbe: async (target: string) =>
			startedProbeSchema.parse(
				await (await t.call("/api/inference/probes", json({ target }))).json(),
			),
		cancelProbe: async (id: string) => {
			await t.call(
				`/api/inference/probes/${encodeURIComponent(id)}/cancel`,
				json({}),
			);
		},
	};
}
export { usagePageQuerySchema } from "../api/domains/inference/contracts";
