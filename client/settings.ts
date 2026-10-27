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
import { z } from "zod";
import { callJson, json, withQuery, type Transport } from "./transport";

const usagePageSchema = z.object({
	items: z.array(usageSchema),
	total: z.number(),
	pageIndex: z.number(),
	pageSize: z.number(),
});
export type { Usage } from "../api/domains/inference/contracts";

export function settingsClient(t: Transport) {
	return {
		excalidrawConnection: async () =>
			callJson(t, excalidrawConnectionSchema, "/api/settings/excalidraw"),
		configureExcalidraw: async (input: ExcalidrawConnectionInput) =>
			callJson(
				t,
				excalidrawConnectionSchema,
				"/api/settings/excalidraw",
				json(excalidrawConnectionInput.parse(input), "PUT"),
			),
		larmVoices: async (signal?: AbortSignal, language?: "ja" | "en") =>
			callJson(
				t,
				ttsVoicesSchema,
				withQuery("/api/inference/voices", { language }),
				{ signal },
			),
		settings: async () => callJson(t, settingsSchema, "/api/settings"),
		applySettings: async (input: ApplySettings) =>
			callJson(t, settingsSchema, "/api/settings/apply", json(input)),
		connectionModels: async (
			connectionId: string,
			signal?: AbortSignal,
			refresh = false,
		) =>
			callJson(
				t,
				connectionModelsSchema,
				withQuery(
					`/api/inference/connections/${encodeURIComponent(connectionId)}/models`,
					{ refresh: refresh ? 1 : undefined },
				),
				{ signal },
			),
		settingsDiagnostics: async () =>
			callJson(t, diagnosticsSchema, "/api/settings/diagnostics"),
		inferenceUsage: async () =>
			callJson(t, usageSchema.array(), "/api/inference/usage"),
		inferenceUsagePage: async (query: UsagePageQuery, signal?: AbortSignal) =>
			callJson(
				t,
				usagePageSchema,
				withQuery("/api/inference/usage/page", query),
				{ signal },
			),
		larmDetails: async () =>
			callJson(t, larmDetailsSchema, "/api/inference/larm"),
		larmProfiles: async () =>
			callJson(t, larmProfilesSchema, "/api/inference/larm/profiles"),
		inferenceProbes: async () =>
			callJson(t, probeSchema.array(), "/api/inference/probes"),
		startProbe: async (target: string) =>
			callJson(
				t,
				startedProbeSchema,
				"/api/inference/probes",
				json({ target }),
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
