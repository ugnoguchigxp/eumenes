import {
	defaultSubtitles,
	settingsSchema,
	type Settings,
} from "../../../../../api/domains/settings/contracts";

/** A minimal valid settings document for section render tests. */
export function settingsFixture(): Settings {
	const route = () => ({
		mode: "larm-preferred" as const,
		cloudAllowed: true,
		fallbackId: null,
		epoch: 0,
	});
	return settingsSchema.parse({
		revision: 1,
		larm: {
			baseUrl: null,
			profile: "SAAA-gemma4-26b",
			audience: "saaa-desktop",
			voice: "",
			speed: 1,
		},
		connections: [],
		resources: [],
		routes: { llm: route(), asr: route(), tts: route() },
		voice: {
			autoSpeak: true,
			outputVolume: 1,
			bargeIn: true,
			inputDevice: "",
			outputDevice: "",
			threshold: 0.008,
			silenceMs: 700,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		general: {
			agentName: "",
			userName: "",
			persona: "butler",
			asrLanguages: ["ja", "en"],
			theme: "system",
			subtitles: defaultSubtitles,
		},
	});
}
