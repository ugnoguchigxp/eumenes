import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { VoiceDialogueService } from "..";
import { registerVoiceDialogue } from "../controller";

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
