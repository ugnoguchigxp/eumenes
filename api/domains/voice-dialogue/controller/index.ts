import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono, Context } from "hono";
import type { VoiceDialogueService } from "..";
import { parseJsonBody } from "../../../infrastructure/http";
import { getLogger } from "../../../infrastructure/logger";
import {
	replayInputSchema,
	sampleInputSchema,
	voiceStartSchema,
} from "../contracts";

const log = getLogger("voice");
const MAX_AUDIO_BYTES = 4_000_000;
async function readAudio(body: ReadableStream<Uint8Array> | null) {
	const wav = await readBounded(body, {
		limit: MAX_AUDIO_BYTES,
		tooLarge: "audio_too_large",
		missing: "audio_empty",
	});
	if (wav.length < 44) throw new Error("audio_empty");
	if (
		String.fromCharCode(...wav.subarray(0, 4)) !== "RIFF" ||
		String.fromCharCode(...wav.subarray(8, 12)) !== "WAVE"
	)
		throw new Error("audio_invalid_wav");
	return wav;
}
export function registerVoiceDialogue(
	app: Hono,
	service: VoiceDialogueService,
) {
	app.post("/api/voice/sessions", async (c) => {
		const parsed = await parseJsonBody(c, voiceStartSchema);
		if (!parsed.ok) return parsed.response;
		return c.json(
			service.start(parsed.data.sessionId, parsed.data.generation),
			201,
		);
	});
	app.post("/api/voice/sessions/stop", async (c) => {
		const parsed = await parseJsonBody(c, voiceStartSchema);
		if (!parsed.ok) return parsed.response;
		await service.stop(parsed.data.sessionId, parsed.data.generation);
		return c.json({ stopped: true });
	});
	const receive = (preview: boolean) => async (c: Context) => {
		const sessionId = c.req.header("x-session-id") ?? "";
		const generation = Number(c.req.header("x-generation"));
		const sequence = Number(c.req.header("x-sequence"));
		const utteranceId = c.req.header("x-utterance-id") ?? "";
		if (
			!voiceStartSchema.safeParse({ sessionId, generation }).success ||
			!Number.isSafeInteger(sequence) ||
			sequence <= 0 ||
			!voiceStartSchema.shape.sessionId.safeParse(utteranceId).success
		)
			return c.json({ error: "invalid_voice_ids" }, 400);
		if (c.req.header("content-type") !== "audio/wav")
			return c.json({ error: "audio_content_type_invalid" }, 415);
		const length = Number(c.req.header("content-length") ?? 0);
		if (length > MAX_AUDIO_BYTES)
			return c.json({ error: "audio_too_large" }, 413);
		let wav: Uint8Array;
		try {
			wav = await readAudio(c.req.raw.body);
		} catch (error) {
			const code =
				error instanceof Error &&
				["audio_empty", "audio_too_large", "audio_invalid_wav"].includes(
					error.message,
				)
					? error.message
					: "audio_incomplete";
			return c.json({ error: code }, code === "audio_too_large" ? 413 : 400);
		}
		if (preview)
			return c.json(
				await service.preview(sessionId, generation, utteranceId, wav),
			);
		return c.json(
			await service.accept(sessionId, generation, sequence, utteranceId, wav),
			202,
		);
	};
	app.post("/api/voice/replay/sentences", async (c) => {
		const parsed = await parseJsonBody(c, replayInputSchema);
		if (!parsed.ok) return parsed.response;
		return c.json({ sentences: service.replaySentences(parsed.data.text) });
	});
	app.post("/api/voice/replay/audio", async (c) => {
		const parsed = await parseJsonBody(c, replayInputSchema);
		if (!parsed.ok) return parsed.response;
		if (parsed.data.text.length > 400)
			return c.json({ error: "invalid_input" }, 400);
		try {
			const speech = await service.replaySpeech(
				parsed.data.text,
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
				parsed.data.runId,
			);
			return c.body(new Uint8Array(speech.wav), 200, {
				"Content-Type": "audio/wav",
				"Cache-Control": "no-store",
				...(speech.delivery
					? { "X-Avatar-Motion": speech.delivery.motion }
					: {}),
			});
		} catch (error) {
			// Only machine-readable codes (e.g. larm_inference_401) reach the client.
			const code = error instanceof Error ? error.message : "";
			log.error(
				"voice.replay_failed",
				{ route: "/api/voice/replay/audio", reason: code || "unknown" },
				error,
			);
			return c.json(
				{ error: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "replay_failed" },
				502,
			);
		}
	});
	app.post("/api/voice/sample", async (c) => {
		const parsed = await parseJsonBody(c, sampleInputSchema);
		if (!parsed.ok) return parsed.response;
		try {
			const wav = await service.sampleAudio(
				parsed.data,
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
			);
			return c.body(new Uint8Array(wav), 200, {
				"Content-Type": "audio/wav",
				"Cache-Control": "no-store",
			});
		} catch (error) {
			const code = error instanceof Error ? error.message : "";
			log.error(
				"voice.sample_failed",
				{ route: "/api/voice/sample", reason: code || "unknown" },
				error,
			);
			return c.json(
				{ error: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "sample_failed" },
				502,
			);
		}
	});
	app.post("/api/voice/turns", receive(false));
	app.post("/api/voice/preview", receive(true));
	app.get("/api/voice/turns/:id", (c) => {
		const turn = service.get(c.req.param("id"));
		return turn ? c.json(turn) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/voice/turns/:id/audio", (c) => {
		const index = Number(c.req.query("index") ?? 0);
		if (!Number.isSafeInteger(index) || index < 0)
			return c.json({ error: "invalid_audio_index" }, 400);
		const wav = service.takeAudio(c.req.param("id"), index);
		return wav
			? c.body(new Uint8Array(wav), 200, {
					"Content-Type": "audio/wav",
					"Cache-Control": "no-store",
				})
			: c.json({ error: "audio_unavailable" }, 404);
	});
	app.post("/api/voice/turns/:id/played", async (c) => {
		const index = Number(c.req.query("index") ?? 0);
		if (!Number.isSafeInteger(index) || index < 0)
			return c.json({ error: "invalid_audio_index" }, 400);
		const turn = await service.played(c.req.param("id"), index);
		return turn ? c.json(turn) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/voice/turns/:id/cancel", async (c) => {
		const turn = await service.cancel(c.req.param("id"));
		return turn ? c.json(turn) : c.json({ error: "not_found" }, 404);
	});
}
