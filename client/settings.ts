import {
	speechRoutingSchema,
	ttsVoicesSchema,
} from "../api/domains/larm/contracts";
import {
	larmDetailsSchema,
	larmProfilesSchema,
	probeSchema,
	startedProbeSchema,
	usageSchema,
} from "../api/domains/inference/contracts";
import {
	diagnosticsSchema,
	settingsSchema,
	type ApplySettings,
} from "../api/domains/settings/contracts";
import { json, type Transport } from "./transport";
export type {
	LarmDetails,
	LarmProfiles,
	Usage,
	Probe,
} from "../api/domains/inference/contracts";
export type { Diagnostics } from "../api/domains/settings/contracts";

export function settingsClient(t: Transport) {
	return {
		speechRouting: async (signal?: AbortSignal) =>
			speechRoutingSchema.parse(
				await (
					await t.call("/api/inference/speech-routing", { signal })
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
		settingsDiagnostics: async () =>
			diagnosticsSchema.parse(
				await (await t.call("/api/settings/diagnostics")).json(),
			),
		inferenceUsage: async () =>
			usageSchema
				.array()
				.parse(await (await t.call("/api/inference/usage")).json()),
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
