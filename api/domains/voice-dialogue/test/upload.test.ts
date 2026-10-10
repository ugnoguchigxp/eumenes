import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { VoiceDialogueService } from "..";
import { registerVoiceDialogue } from "../controller";
import { configureLogging } from "../../../infrastructure/logger";

const sessionId = "4f996733-ddda-4b2f-85fb-173a61159e80";
const utteranceId = "7cd03a9c-af76-4506-9bd6-d536574ac83f";
const headers = {
	"Content-Type": "audio/wav",
	"X-Session-Id": sessionId,
	"X-Generation": "1",
	"X-Sequence": "1",
	"X-Utterance-Id": utteranceId,
};

test("bounded audio stream rejects oversized upload before ASR", async () => {
	let accepted = 0;
	const app = new Hono();
	registerVoiceDialogue(app, {
		accept: async () => {
			accepted++;
			return { status: "recognizing" };
		},
	} as unknown as VoiceDialogueService);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(3_000_000));
			controller.enqueue(new Uint8Array(1_000_001));
			controller.close();
		},
	});
	const request = new Request("http://localhost/api/voice/turns", {
		method: "POST",
		headers,
		body,
		duplex: "half",
	} as RequestInit);
	const response = await app.request(request);
	expect(response.status).toBe(413);
	expect(await response.json()).toEqual({ error: "audio_too_large" });
	expect(accepted).toBe(0);
});

test("valid bounded WAV reaches voice service once", async () => {
	let accepted = 0;
	const app = new Hono();
	registerVoiceDialogue(app, {
		accept: async (
			session: string,
			generation: number,
			sequence: number,
			utterance: string,
			wav: Uint8Array,
		) => {
			accepted++;
			expect([session, generation, sequence, utterance]).toEqual([
				sessionId,
				1,
				1,
				utteranceId,
			]);
			expect(wav.length).toBe(44);
			return { status: "recognizing" };
		},
	} as unknown as VoiceDialogueService);
	const wav = new Uint8Array(44);
	wav.set(new TextEncoder().encode("RIFF"), 0);
	wav.set(new TextEncoder().encode("WAVE"), 8);
	const response = await app.request("/api/voice/turns", {
		method: "POST",
		headers,
		body: wav,
	});
	expect(response.status).toBe(202);
	expect(accepted).toBe(1);
});

test("replay failure logs and returns a code, never the raw message", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "debug",
		destination: { write: (line) => void lines.push(line) },
	});
	try {
		const app = new Hono();
		registerVoiceDialogue(app, {
			replaySpeech: async () => {
				throw new Error("http://192.168.0.2/secret failed");
			},
		} as unknown as VoiceDialogueService);
		const response = await app.request("/api/voice/replay/audio", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "よかったですね。" }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "replay_failed" });
		const entry = lines
			.map((line) => JSON.parse(line))
			.find((e) => e.event === "voice.replay_failed");
		expect(entry?.reason).toBe("replay_failed");
		expect(lines.join("\n")).not.toContain("192.168.0.2");
	} finally {
		configureLogging({ level: "silent" });
	}
});
