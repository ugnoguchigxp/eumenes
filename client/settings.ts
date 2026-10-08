import type { LarmExchange } from "../api/domains/larm/contracts";
import { ttsVoicesSchema } from "../api/domains/larm/contracts";
import {
	settingsSchema,
	type ApplySettings,
} from "../api/domains/settings/contracts";
import { json, type Transport } from "./transport";
export interface Usage {
	id: string;
	requestId: string;
	subject: string;
	purpose: "llm" | "asr" | "tts";
	source: string;
	model: string;
	status: string;
	reason: string | null;
	started: number;
	ended: number | null;
	accepted: number;
	inputTokens: number | null;
	outputTokens: number | null;
	providerDetails?: LarmExchange[];
}
export interface Probe {
	id: string;
	target: string;
	status: string;
	error: string | null;
	revision: number;
	created: number;
}
export interface Diagnostics {
	keyError: string | null;
	connections: Array<{
		id: string;
		credentialAvailable: boolean;
		source: string;
	}>;
}
export function settingsClient(t: Transport) {
	return {
		larmVoices: async (signal?: AbortSignal) =>
			ttsVoicesSchema.parse(
				await (await t.call("/api/inference/voices", { signal })).json(),
			),
		settings: async () =>
			settingsSchema.parse(await (await t.call("/api/settings")).json()),
		applySettings: async (input: ApplySettings) =>
			settingsSchema.parse(
				await (await t.call("/api/settings/apply", json(input))).json(),
			),
		settingsDiagnostics: async () =>
			(await (await t.call("/api/settings/diagnostics")).json()) as Diagnostics,
		inferenceUsage: async () =>
			(await (await t.call("/api/inference/usage")).json()) as Usage[],
		larmDetails: async () =>
			(await (await t.call("/api/inference/larm")).json()) as {
				profile: string;
				connectionId?: string;
				providers: Array<{
					name: string;
					model: string;
					baseUrl: string;
					protocol: string;
				}>;
			},
		inferenceProbes: async () =>
			(await (await t.call("/api/inference/probes")).json()) as Probe[],
		startProbe: async (target: string) =>
			(await (
				await t.call("/api/inference/probes", json({ target }))
			).json()) as { id: string },
		cancelProbe: async (id: string) => {
			await t.call(
				`/api/inference/probes/${encodeURIComponent(id)}/cancel`,
				json({}),
			);
		},
	};
}
