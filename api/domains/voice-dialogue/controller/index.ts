import type { Hono, Context } from "hono";
import type { VoiceDialogueService } from "..";
import { voiceStartSchema } from "../contracts";

const MAX_AUDIO_BYTES = 4_000_000;
async function readAudio(body: ReadableStream<Uint8Array> | null) {
	if (!body) throw new Error("audio_empty");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_AUDIO_BYTES) throw new Error("audio_too_large");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	if (length < 44) throw new Error("audio_empty");
	const wav = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		wav.set(chunk, offset);
		offset += chunk.length;
	}
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
		const parsed = voiceStartSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
		return c.json(
			service.start(parsed.data.sessionId, parsed.data.generation),
			201,
		);
	});
	app.post("/api/voice/sessions/stop", async (c) => {
		const parsed = voiceStartSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
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
