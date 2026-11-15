import type { Hono } from "hono";
import type { VoiceDialogueService } from "..";
import { parseJsonBody } from "../../../infrastructure/http";
import { sseStream, sseFrame, SSE_HEADERS } from "../../../infrastructure/sse";
import { runSpeechInputSchema, runSpeechPlayedSchema } from "../contracts";

export function registerRunSpeech(app: Hono, service: VoiceDialogueService) {
	app.post("/api/voice/runs/:id/speech", async (c) => {
		const parsed = await parseJsonBody(c, runSpeechInputSchema);
		if (!parsed.ok) return parsed.response;
		const session = service.openRunSpeech(
			c.req.param("id"),
			parsed.data.screenId,
			c.req.raw.signal,
		);
		return c.body(
			sseStream({
				signal: c.req.raw.signal,
				highWaterMark: 8,
				lagging: "disconnect",
				open: (sink) =>
					session.connect(
						(event) => sink.send(sseFrame({ data: JSON.stringify(event) })),
						() => sink.end(),
					),
			}),
			200,
			SSE_HEADERS,
		);
	});
	app.post("/api/voice/runs/:id/speech/:sessionId/played", async (c) => {
		const parsed = await parseJsonBody(c, runSpeechPlayedSchema);
		if (!parsed.ok) return parsed.response;
		await service.runSpeechPlayed(
			c.req.param("id"),
			c.req.param("sessionId"),
			parsed.data,
		);
		return c.json({ ok: true });
	});
}
