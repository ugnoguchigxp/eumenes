import { expect, test } from "bun:test";
import { ttsVoicesSchema, type LarmCallOptions } from "../contracts";
import type { Provider } from "../service/profiles";
import { createSpeechSynthesizer } from "../service/speech";

test("per-request voice and style use the existing provider and leave subsequent speech unchanged", async () => {
	const catalog = ttsVoicesSchema.parse({
		model: "model-tts-rich",
		default_voice: "a",
		voices: [
			{
				id: "a",
				styles: [{ id: "normal", display_name: "Normal" }],
				capabilities: { speed: { minimum: 0.5, maximum: 2, default: 1 } },
			},
			{
				id: "b",
				styles: [{ id: "soft", display_name: "Soft" }],
				capabilities: {
					speed: { minimum: 0.5, maximum: 2, default: 1 },
					pitch_scale: { minimum: -0.15, maximum: 0.15, default: 0 },
					intonation_scale: { minimum: 0, maximum: 2, default: 1 },
				},
			},
		],
	});
	const provider: Provider = {
		name: "tts",
		model: catalog.model,
		baseUrl: "http://localhost",
		protocol: "openai.audio-speech.v1",
		token: "fixture",
	};
	const voiceCatalogs = new WeakMap<Provider, typeof catalog>();
	voiceCatalogs.set(provider, catalog);
	const requests: Record<string, unknown>[] = [];
	const speak = createSpeechSynthesizer({
		voice: "a",
		config: { style: "normal", speed: 1.2 },
		voiceCatalogs,
		readVoices: async () => catalog,
		withProvider: async (_name, _signal, use) =>
			use(provider, "existing-connection"),
		japaneseVoice: () => provider,
		infer: async (p, _operation, init, _signal, connection) => {
			expect(p).toBe(provider);
			expect(connection).toBe("existing-connection");
			requests.push(JSON.parse(String(init.body)));
			const bytes = new Uint8Array(44);
			bytes.set(new TextEncoder().encode("RIFF"));
			bytes.set(new TextEncoder().encode("WAVE"), 8);
			return new Response(bytes);
		},
	});
	const signal = new AbortController().signal;
	const override: LarmCallOptions["speechOverride"] = {
		voice: "b",
		style: "soft",
		speed: 1.4,
		pitchScale: 0.03,
		intonationScale: 1.15,
	};
	await speak("Sample", signal, { speechOverride: override });
	expect(requests[0]).toMatchObject({
		voice: "b",
		style: "soft",
		speed: 1.4,
		pitch_scale: 0.03,
		intonation_scale: 1.15,
	});
	await speak("Saved", signal);
	expect(requests[1]).toMatchObject({
		voice: "a",
		style: "normal",
		speed: 1.2,
	});
	await speak("Default", signal, {
		speechOverride: { voice: "", style: undefined },
	});
	expect(requests[2]?.voice).toBe("a");
	expect(requests[2]).not.toHaveProperty("style");
	await expect(
		speak("Invalid", signal, {
			speechOverride: { voice: "b", style: "not-listed" },
		}),
	).rejects.toThrow("larm_tts_voice_style_invalid");
});

test("a voice whose catalog entry declares no styles or ranges receives neither", async () => {
	const catalog = ttsVoicesSchema.parse({
		model: "model-tts-plain",
		default_voice: "plain",
		voices: [{ id: "plain" }],
	});
	const provider: Provider = {
		name: "tts",
		model: catalog.model,
		baseUrl: "http://localhost",
		protocol: "openai.audio-speech.v1",
		token: "fixture",
	};
	const requests: Record<string, unknown>[] = [];
	const speak = createSpeechSynthesizer({
		voice: "plain",
		config: { style: "normal", speed: 1.2, pitchScale: 0.05 },
		voiceCatalogs: new WeakMap([[provider, catalog]]),
		readVoices: async () => catalog,
		withProvider: async (_name, _signal, use) => use(provider, "connection"),
		japaneseVoice: () => provider,
		infer: async (_p, _operation, init) => {
			requests.push(JSON.parse(String(init.body)));
			const bytes = new Uint8Array(44);
			bytes.set(new TextEncoder().encode("RIFF"));
			bytes.set(new TextEncoder().encode("WAVE"), 8);
			return new Response(bytes);
		},
	});
	await speak("Sample", new AbortController().signal, {
		intonationScale: 1.5,
	});
	expect(requests[0]).toEqual({
		model: "model-tts-plain",
		input: "Sample",
		voice: "plain",
		speed: 1.2,
		response_format: "wav",
	});
});
