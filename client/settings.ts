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
	usageSchema,
} from "../api/domains/inference/contracts";
import {
	diagnosticsSchema,
	intentPatchSchema,
	intentSettingsSchema,
	settingsSchema,
	type ApplySettings,
} from "../api/domains/settings/contracts";
import { z } from "zod";
import { callJson, json, withQuery, type Transport } from "./transport";

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
		/** The user-intent judge's settings, apart from the speaking-attitude judge's. */
		intentSettings: async () =>
			callJson(t, intentSettingsSchema, "/api/settings/intent"),
		configureIntent: async (input: z.infer<typeof intentPatchSchema>) =>
			callJson(
				t,
				intentSettingsSchema,
				"/api/settings/intent",
				json(intentPatchSchema.parse(input), "PUT"),
			),
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
		larmDetails: async () =>
			callJson(t, larmDetailsSchema, "/api/inference/larm"),
		larmProfiles: async () =>
			callJson(t, larmProfilesSchema, "/api/inference/larm/profiles"),
	};
}
export { usagePageQuerySchema } from "../api/domains/inference/contracts";
