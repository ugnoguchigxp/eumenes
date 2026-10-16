import { type Sample } from "../../attitude-dataset";
import { emotionSchema } from "../../delivery";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
	ATTITUDE_MODEL,
	cleanup,
	setup,
	wav,
	freshSignal,
	judged,
	enableEnglishSpeech,
} from "./inference.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("judge absence preserves the immutable manual baseline for every phrase", async () => {
	const adjustments: Array<number | undefined> = [];
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			adjustments.push(options?.intonationScale);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	s.larm.intonationScale = 1.1;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"question-phrase",
			"tts",
			Date.now() + 10000,
		),
	);
	const newer = h.settings.get();
	newer.larm.intonationScale = 1.9;
	newer.larm.autoIntonation = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: newer.revision,
		settings: newer,
		keys: [],
	});
	await h.inference.executeRequest(
		id,
		"確認しますか？",
		new AbortController().signal,
	);
	await h.inference.speak(
		"ありがとうございます！",
		new AbortController().signal,
	);
	expect(adjustments).toEqual([undefined, undefined]);
});
test("Laya judges the spoken text and carries one decision with bounded immutable voice settings", async () => {
	const states: unknown[] = [],
		parameters: Array<import("../../larm").LarmCallOptions | undefined> = [];
	const h = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
		judge: async (state) => {
			states.push(state);
			return judged;
		},
		localSpeech: async (_text, _signal, options) => {
			parameters.push(options);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	s.larm.speed = 1.1;
	s.larm.pitchScale = 0.01;
	s.larm.intonationScale = 1.2;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "delivery", "tts", Date.now() + 10000),
	);
	const changed = h.settings.get();
	changed.larm.speed = 1.8;
	changed.larm.autoIntonation = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: changed.revision,
		settings: changed,
		keys: [],
	});
	const receipt = await h.inference.executeRequest(
		id,
		"こんにちはSAAA！",
		freshSignal(),
	);
	expect(states).toEqual([
		{ response: "こんにちはサー！", current_chunk: "こんにちはサー！" },
	]);
	expect(receipt.delivery).toMatchObject({
		motion: "agreeing",
		tone: "bright",
		source: "laya",
		confidence: 0.8,
	});
	expect(parameters[0]?.speed).toBeCloseTo(1.15);
	expect(parameters[0]?.pitchScale).toBeCloseTo(0.03);
	expect(parameters[0]?.intonationScale).toBeCloseTo(1.35);
	await h.inference.speak("手動設定", freshSignal());
	expect(parameters[1]).not.toHaveProperty("speed");
	expect(parameters[1]).not.toHaveProperty("pitchScale");
	expect(parameters[1]).not.toHaveProperty("intonationScale");
	const beforeReplay = new Set(
		h.inference.usage().map((attempt) => attempt.id),
	);
	const replay = await h.inference.speakWithDelivery(
		"もう一度こんにちは！",
		freshSignal(),
	);
	expect(replay.wav).toEqual(wav());
	expect(replay.delivery).toMatchObject({ motion: "agreeing", source: "laya" });
	const replayAttempts = h.inference
		.usage()
		.filter((attempt) => !beforeReplay.has(attempt.id));
	expect(replayAttempts).toHaveLength(1);
	expect(replayAttempts[0]?.accepted).toBe(1);
});
test("decision timeout keeps manual voice, fences late results and cancellation prevents synthesis", async () => {
	let resolve!: (value: unknown) => void;
	let judging: AbortSignal | undefined;
	const parameters: unknown[] = [];
	const h = await setup({
		decisionMs: 10,
		judge: async (_state, _q, signal) => {
			judging = signal;
			return new Promise((r) => {
				resolve = r;
			});
		},
		localSpeech: async (_text, _signal, options) => {
			parameters.push(options);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "timeout", "tts", Date.now() + 10000),
	);
	const receipt = await h.inference.executeRequest(
		id,
		"やった！",
		freshSignal(),
	);
	expect(receipt.delivery).toMatchObject({
		source: "fallback",
		reason: "timeout",
		motion: "neutral",
	});
	expect(parameters[0]).not.toHaveProperty("intonationScale");
	expect(judging?.aborted).toBe(true);
	resolve(judged);
	await Bun.sleep(1);
	expect(receipt.delivery?.source).toBe("fallback");
	const next = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "cancel", "tts", Date.now() + 10000),
	);
	const abort = new AbortController();
	const pending = h.inference.executeRequest(
		next,
		"こんにちは。",
		abort.signal,
	);
	await waitFor(() => judging !== undefined && !judging.aborted);
	abort.abort();
	await expect(pending).rejects.toThrow();
	resolve(judged);
	expect(parameters).toHaveLength(1);
	expect(h.calls).toHaveLength(0);
});
test("speech text is rewritten for the local provider and for the cloud fallback", async () => {
	const local: string[] = [];
	const h = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
		localSpeech: async (text) => {
			local.push(text);
			return wav();
		},
	});
	await h.inference.speak("SAAAです", new AbortController().signal);
	expect(local).toEqual(["サーです"]);
	const cloud = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
	});
	await cloud.inference.speak("SAAAです", new AbortController().signal);
	expect(JSON.parse(cloud.payloads.at(-1) as string).input).toBe("サーです");
});
test("speak with an override synthesizes with unsaved voice settings without changing saved ones", async () => {
	let observed: import("../../larm").LarmCallOptions | undefined;
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			observed = options;
			return wav();
		},
	});
	const before = h.settings.get().larm;
	await h.inference.speak("サンプル", new AbortController().signal, {
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(observed?.speechOverride).toMatchObject({
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(h.settings.get().larm).toEqual(before);
});
test("sample voice overrides remain usable with English speech routing enabled; authority uses saved settings", async () => {
	let observed: import("../../larm").LarmCallOptions | undefined;
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			observed = options;
			return wav();
		},
	});
	await enableEnglishSpeech(h);
	const before = h.settings.get();
	expect(
		await h.inference.speak("試聴です。", freshSignal(), {
			voice: "Zundamon",
			style: "normal",
			speed: 1.4,
			pitchScale: 0.03,
			intonationScale: 1.2,
		}),
	).toEqual(wav());
	expect(observed?.speechOverride).toMatchObject({
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
		pitchScale: 0.03,
		intonationScale: 1.2,
	});
	expect(h.settings.get()).toEqual(before);
	expect(h.seen).toHaveLength(1);
	expect(
		h.inference.usage().some((r) => r.purpose === "tts" && r.accepted),
	).toBe(true);
});
test("a sample shares the existing port through unrelated saves", async () => {
	let finish!: (bytes: Uint8Array) => void;
	let entered = false;
	const h = await setup({
		localSpeech: async () => {
			entered = true;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	await enableEnglishSpeech(h, true);
	const close = spyOn(h.port, "close");
	const sample = h.inference
		.speak("試聴です。", freshSignal(), { voice: "Zundamon", speed: 1.1 })
		.catch((e) => e);
	await waitFor(() => entered);
	const unrelated = h.settings.get();
	unrelated.general.agentName = "changed-name";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: unrelated.revision,
		settings: unrelated,
		keys: [],
	});
	expect(close).not.toHaveBeenCalled();
	finish(wav());
	expect(await sample).toEqual(wav());
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted),
	).toHaveLength(1);
});
test("Ruri dataset captures real-turn receipt adoption once; a technical collection request does not delay answer or TTS", async () => {
	let calls = 0;
	const h = await setup({
		dataset: true,
		local: async () => "手順を説明します。",
		localSpeech: async () => wav(),
		judge: async () => {
			calls++;
			return {
				model: ATTITUDE_MODEL,
				answers: {
					emotion: {
						type: "choice",
						choice: "none",
						confidence: 0.9,
						answer_confidence: 0.9,
						logits: Object.fromEntries(
							emotionSchema.options.map((k) => [k, k === "none" ? 3 : 0]),
						),
						probabilities: Object.fromEntries(
							emotionSchema.options.map((k) => [k, k === "none" ? 0.9 : 0.02]),
						),
					},
				},
			};
		},
	});
	await h.dataset!.setEnabled(true);
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "real-run", "llm", Date.now() + 10000),
	);
	const preparation = {
		collection: {
			conversationId: "conversation",
			turnId: "real-run",
			granularity: "answer" as const,
			chunkOrder: null,
		},
	};
	const receipt = await h.inference.executeStream(
		id,
		[{ role: "user", content: "設定方法は？" }],
		freshSignal(),
		() => {},
		preparation,
	);
	expect(receipt.delivery!.source).toBe("ruri");
	expect(calls).toBe(1);
	await h.dataset!.drain();
	expect(h.dataset!.status().successful).toBe(1);
	await h.store.write((db) => h.inference.acceptInTransaction(db, receipt));
	const audio = await h.inference.speakWithDelivery(
		"手順を説明します。",
		freshSignal(),
		{ delivery: receipt.delivery, collection: preparation.collection },
	);
	expect(audio.wav.length).toBeGreaterThan(0);
	expect(calls).toBe(1);

	await h.dataset!.drain();
	const sample = h.dataset!.get(
		h.dataset!.list()[0]!.sample_id,
		false,
	) as Sample;
	expect(sample.user_utterance).toBe("設定方法は？");
	expect(sample.adopted?.source).toBe("ruri");
	expect(sample.adopted?.voice_application).toBe("manual");
	expect(sample.adopted?.tone).toBeNull();
	expect(sample.primary_label).toBeNull();
});
test("each clause routes by its own text; English bypasses the Japanese dictionary; disabling routing keeps the Japanese voice", async () => {
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup({
		speechText: (text) => text.replace("API", "エーピーアイ"),
		localSpeech: async (text, _signal, options) => {
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	await enableEnglishSpeech(h, true);
	await h.inference.speakWithDelivery("Open the API settings.", freshSignal());
	await h.inference.speakWithDelivery("APIを確認します。", freshSignal());
	await h.inference.speak(
		"ここで Open the settings を押します。",
		freshSignal(),
	);
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	await h.inference.speak("Open the settings.", freshSignal());
	expect(spoken).toEqual([
		["Open the API settings.", "en"],
		["エーピーアイを確認します。", "ja"],
		// A mixed request that was not split is spoken by the Japanese voice.
		["ここで Open the settings を押します。", "ja"],
		["Open the settings.", undefined],
	]);
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted).length,
	).toBe(4);
});
test("without an English voice an English clause is spoken by the Japanese voice with its dictionary", async () => {
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup({
		speechText: (text) => `辞書${text}`,
		localSpeech: async (text, _signal, options) => {
			if (options?.speechLanguage === "en")
				throw new Error("speech_tts_target_unavailable");
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	await enableEnglishSpeech(h, true);
	expect(
		await h.inference.speak("Thank you for waiting.", freshSignal()),
	).toEqual(wav());
	expect(spoken).toEqual([["辞書Thank you for waiting.", "ja"]]);
	expect(h.calls).toEqual([]);
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted).length,
	).toBe(1);
});
test("an English voice synthesis error is not retried with the Japanese voice", async () => {
	const languages: Array<string | undefined> = [];
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			languages.push(options?.speechLanguage);
			throw new Error("larm_inference_500");
		},
	});
	await enableEnglishSpeech(h, true);
	await expect(
		h.inference.speak("Thank you for waiting.", freshSignal()),
	).rejects.toThrow("larm_inference_500");
	expect(languages).toEqual(["en"]);
});
test("when the LARM voices are unavailable every clause falls back to cloud speech without language routing", async () => {
	const languages: Array<string | undefined> = [];
	const h = await setup({
		speechText: (text) => `辞書${text}`,
		localSpeech: async (_text, _signal, options) => {
			languages.push(options?.speechLanguage);
			throw new Error(
				options?.speechLanguage === "en"
					? "speech_tts_target_unavailable"
					: "larm_inference_503",
			);
		},
	});
	await enableEnglishSpeech(h);
	expect(
		await h.inference.speak("Thank you for waiting.", freshSignal()),
	).toEqual(wav());
	expect(await h.inference.speak("今日は晴れです。", freshSignal())).toEqual(
		wav(),
	);
	// English falls to the Japanese voice first; each voice cools down on its own.
	expect(languages).toEqual(["en", "ja", "ja"]);
	const speech = h.calls.filter((url) => url.endsWith("audio/speech"));
	expect(speech).toHaveLength(2);
	const inputs = h.payloads
		.filter((body): body is string => typeof body === "string")
		.map((body) => JSON.parse(body) as { input?: string })
		.map((body) => body.input);
	expect(inputs).toEqual([
		"辞書Thank you for waiting.",
		"辞書今日は晴れです。",
	]);
});
