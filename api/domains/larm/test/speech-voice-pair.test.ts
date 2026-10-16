import { expect, test } from "bun:test";
import { ttsVoicesSchema, type TtsVoices } from "../contracts";
import type { Provider } from "../service/profiles";
import { createSpeechSynthesizer } from "../service/speech";

const japanese = ttsVoicesSchema.parse({
	model: "model-tts-rich",
	default_voice: "voice-a",
	voices: [
		{ id: "voice-a", voice_presentation: "feminine" },
		{ id: "voice-b", voice_presentation: "androgynous" },
		{ id: "voice-c", voice_presentation: "feminine" },
		{ id: "voice-d", voice_presentation: "feminine" },
		{ id: "voice-e", voice_presentation: "masculine" },
		{ id: "voice-f", voice_presentation: "masculine" },
		{ id: "unknown", voice_presentation: "unspecified" },
	],
});
const english = ttsVoicesSchema.parse({
	model: "english-fixture",
	default_voice: "Jasper",
	voices: [
		{ id: "Rosie", voice_presentation: "feminine" },
		{ id: "Jasper", voice_presentation: "masculine" },
	],
});
function setup(
	voice: string | undefined,
	englishCatalog = english,
	config = { speed: 1.4 },
	onRead?: () => void,
) {
	const jp: Provider = {
		name: "tts",
		model: japanese.model,
		baseUrl: "http://localhost",
		protocol: "openai.audio-speech.v1",
		token: "jp",
	};
	const en: Provider = {
		...jp,
		name: "tts-english",
		model: english.model,
		token: "en",
	};
	const voiceCatalogs = new WeakMap<Provider, TtsVoices>();
	const requests: unknown[] = [];
	let discoveries = 0;
	const speak = createSpeechSynthesizer({
		voice,
		config,
		voiceCatalogs,
		withProvider: async (name, signal, use) => {
			signal.throwIfAborted();
			return use(name === "tts" ? jp : en, "connection");
		},
		japaneseVoice: () => jp,
		readVoices: async (p) => {
			onRead?.();
			discoveries++;
			const catalog = p === jp ? japanese : englishCatalog;
			voiceCatalogs.set(p, catalog);
			return catalog;
		},
		infer: async (_p, _operation, init) => {
			requests.push(JSON.parse(String(init.body)));
			const wav = new Uint8Array(44);
			wav.set(new TextEncoder().encode("RIFF"));
			wav.set(new TextEncoder().encode("WAVE"), 8);
			return new Response(wav);
		},
	});
	return { speak, requests, discoveries: () => discoveries };
}
test.each([
	["voice-a", "Rosie"],
	["voice-b", "Rosie"],
	["voice-c", "Rosie"],
	["voice-d", "Rosie"],
	["voice-e", "Jasper"],
	["voice-f", "Jasper"],
	[undefined, "Rosie"],
])(
	"Japanese metadata %s selects the common English voice %s",
	async (voice, expected) => {
		const h = setup(voice);
		await h.speak("An English sentence.", new AbortController().signal, {
			speechLanguage: "en",
		});
		expect(h.requests).toEqual([
			{
				model: english.model,
				input: "An English sentence.",
				voice: expected,
				speed: 1,
				response_format: "wav",
			},
		]);
	},
);
test("catalogs are reused across clauses and Japanese synthesis keeps its own voice", async () => {
	const h = setup("voice-e");
	const signal = new AbortController().signal;
	await h.speak("First.", signal, { speechLanguage: "en" });
	await h.speak("Second.", signal, { speechLanguage: "en" });
	expect(h.discoveries()).toBe(2);
	await h.speak("日本語です。", signal, { speechLanguage: "ja" });
	expect(h.requests[2]).toMatchObject({
		voice: "voice-e",
		model: japanese.model,
		speed: 1.4,
	});
});
test.each(["unknown", "absent"])(
	"unknown presentation %s cannot silently select a different voice",
	async (voice) => {
		const h = setup(voice);
		await expect(
			h.speak("English.", new AbortController().signal, {
				speechLanguage: "en",
			}),
		).rejects.toThrow("larm_tts_voice_presentation_unavailable");
		expect(h.requests).toHaveLength(0);
	},
);
test("Jasper must actually be declared masculine", async () => {
	const changed = structuredClone(english);
	changed.voices.find((v) => v.id === "Jasper")!.voice_presentation =
		"feminine";
	const h = setup("voice-e", changed);
	await expect(
		h.speak("English.", new AbortController().signal, { speechLanguage: "en" }),
	).rejects.toThrow("larm_tts_voice_presentation_mismatch");
	expect(h.requests).toHaveLength(0);
});
test("legacy English overrides cannot change the fixed voice or speed", async () => {
	const legacy = {
		speed: 1.4,
		englishSpeed: 2,
		englishVoice: "Hugo",
		englishMasculineVoice: "Leo",
	};
	const h = setup("voice-e", english, legacy);
	await h.speak("English.", new AbortController().signal, {
		speechLanguage: "en",
	});
	expect(h.discoveries()).toBe(2);
	expect(h.requests[0]).toMatchObject({ voice: "Jasper", speed: 1 });
});

test("cancellation during catalog discovery cannot reach speech inference", async () => {
	const abort = new AbortController();
	const h = setup("voice-a", english, { speed: 1.4 }, () => abort.abort());
	await expect(
		h.speak("English.", abort.signal, { speechLanguage: "en" }),
	).rejects.toThrow();
	expect(h.requests).toHaveLength(0);
});

test("one-off voice uses the avatar gender while English speed remains fixed", async () => {
	const h = setup("voice-a");
	await h.speak("Sample.", new AbortController().signal, {
		speechLanguage: "en",
		speechOverride: { voice: "voice-e", speed: 1.9, pitchScale: 0.1 },
	});
	expect(h.requests[0]).toMatchObject({ voice: "Jasper", speed: 1 });
});
