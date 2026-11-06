import { expect, test } from "bun:test";
import { registerVoiceDialogue } from "..";
import { createApp } from "../../../application/app";
import {
	createSettingsVoiceFixture,
	ready,
	say,
	until,
	wav,
} from "./settings-voice.fixture";
const { setup } = createSettingsVoiceFixture();

test("an adopted mixed answer is routed per language part and synthesis stays bounded until playback acknowledgements", async () => {
	const source =
		"最初です、Open the door, 次です、Close the door, 最後です、Thank you.";
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup(undefined, {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		transcribe: async () => "質問",
		answer: async () => source,
		speak: async (text, _signal, options) => {
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = true;
	for (const p of ["llm", "asr", "tts"] as const)
		value.routes[p].mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => h.voice.get(id)?.audioChunks.length === 3);
	expect(spoken).toEqual([
		["最初です、", "ja"],
		["Open the door,", "en"],
		["次です、", "ja"],
	]);
	for (let index = 0; index < 6; index++) {
		await until(() => !!h.voice.takeAudio(id, index));
		await h.voice.played(id, index);
	}
	await until(() => h.voice.get(id)?.status === "played");
	expect(spoken.slice(3)).toEqual([
		["Close the door,", "en"],
		["最後です、", "ja"],
		["Thank you.", "en"],
	]);
	const run = h.dialogue.list("main")[0]!;
	await h.voice.replaySpeech(
		"Open the door,",
		new AbortController().signal,
		run.id,
	);
	expect(spoken.at(-1)).toEqual(["Open the door,", "en"]);
});

test("without an English voice every clause is still spoken by the Japanese voice", async () => {
	const source = "First, Second, Third.";
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup(undefined, {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		transcribe: async () => "質問",
		answer: async () => source,
		speak: async (text, _signal, options) => {
			if (options?.speechLanguage === "en")
				throw new Error("speech_tts_target_unavailable");
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = true;
	for (const p of ["llm", "asr", "tts"] as const)
		value.routes[p].mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => h.voice.get(id)?.audioChunks.length === 3);
	expect(spoken).toEqual([
		["First,", "ja"],
		["Second,", "ja"],
		["Third.", "ja"],
	]);
	expect(h.voice.get(id)?.status).not.toBe("failed");
	expect(h.conversation.get("main").messages.at(-1)?.text).toBe(source);
});

test("sample HTTP route executes inference with English speech routing and draft voice without persisting it", async () => {
	const h = await setup(undefined, {
		speak: async () => wav(),
	});
	const settings = h.settings.get();
	settings.larm.englishSpeechEnabled = true;
	settings.routes.tts.mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const before = h.settings.get();
	const token = "sample-http-fixture-token-32-bytes";
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (app) => registerVoiceDialogue(app, h.voice) }],
	});
	const response = await app.request("/api/voice/sample", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			voice: "unsaved-voice",
			speed: 1.1,
			style: "draft-style",
		}),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("audio/wav");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav());
	expect(h.settings.get()).toEqual(before);
	expect(
		h.inference.usage().some((r) => r.purpose === "tts" && r.accepted),
	).toBe(true);
});

test("a committed utterance carries the saved item on screen to its run, like a typed message", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "この写真について教えて",
		answer: async () => "確認します。",
		speak: async () => wav(),
	});
	// This fixture's schema has no run viewing column; the dialogue's own tests cover how it is kept.
	const received: unknown[] = [];
	const submitVoice = h.dialogue.submitVoice;
	h.dialogue.submitVoice = (input, ...rest) => {
		const { viewing, ...plain } = input;
		received.push(viewing);
		return submitVoice(plain, ...rest);
	};
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)!.status === "input_ready");
	const viewing = {
		artifactRevisionId: "artifact:object-recognition.workspace@2",
		targetRef: crypto.randomUUID(),
	};
	await h.voice.commit(id, h.voice.get(id)!.revision, viewing);
	await until(() => !!h.voice.get(id)!.runId);
	expect(received).toEqual([viewing]);
});
