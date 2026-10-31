import type { Hono, Context } from "hono";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { SSE_HEADERS } from "../../../infrastructure/sse";
import type { LiveVoiceService } from "../service";
import { liveStartSchema, activeStatuses } from "../contracts";

const audioSchema = z
	.object({
		sequence: z.number().int().positive(),
		audio: z.string().max(40000),
	})
	.strict();
async function body<S extends z.ZodType>(
	c: Context,
	schema: S,
): Promise<z.output<S>> {
	const bytes = await readBounded(c.req.raw.body, {
		limit: 65536,
		missing: "live_invalid_input",
		tooLarge: "live_invalid_input",
	});
	try {
		return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new Error("live_invalid_input");
	}
}
export function registerLiveVoice(app: Hono, service: LiveVoiceService) {
	app.get("/api/live/models", async (c) =>
		c.json(await service.models(c.req.raw.signal)),
	);
	app.get("/api/live/conversations/:id", (c) =>
		c.json(service.current(c.req.param("id"))),
	);
	app.post("/api/live/sessions", async (c) =>
		c.json(await service.start(await body(c, liveStartSchema)), 201),
	);
	app.get("/api/live/sessions/:id", (c) => {
		const value = service.state(c.req.param("id"));
		return value ? c.json(value) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/live/sessions/:id/audio", async (c) => {
		const input = await body(c, audioSchema);
		await service.audio(c.req.param("id"), input.sequence, input.audio);
		return c.body(null, 204);
	});
	app.post("/api/live/sessions/:id/mute", async (c) => {
		const input = await body(c, z.object({ muted: z.boolean() }).strict());
		await service.mute(c.req.param("id"), input.muted);
		return c.body(null, 204);
	});
	app.post("/api/live/sessions/:id/stop", async (c) =>
		c.json(await service.stop(c.req.param("id"))),
	);
	app.post("/api/live/sessions/:id/notices/:notice/displayed", async (c) => {
		await service.delivery.displayed(c.req.param("id"), c.req.param("notice"));
		return c.body(null, 204);
	});
	app.get("/api/live/sessions/:id/stream", (c) => {
		const id = c.req.param("id");
		if (!service.state(id)) return c.json({ error: "not_found" }, 404);
		const encoder = new TextEncoder();
		let detach: (() => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let ended = false;
		const cleanup = () => {
			if (ended) return;
			ended = true;
			clearInterval(heartbeat);
			detach?.();
		};
		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					const push = (text: string) => {
						if (ended) return;
						if ((controller.desiredSize ?? 0) < 0) {
							cleanup();
							controller.error(new Error("live_stream_backpressure"));
							return;
						}
						controller.enqueue(encoder.encode(text));
					};
					detach = service.attach(id, (event) => {
						push(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
						if (
							event.type === "state" &&
							!activeStatuses.includes(event.state.status)
						) {
							ended = true;
							clearInterval(heartbeat);
							controller.close();
						}
					});
					if (!ended)
						heartbeat = setInterval(() => push(": keepalive\n\n"), 15000);
					c.req.raw.signal.addEventListener(
						"abort",
						() => {
							cleanup();
							try {
								controller.close();
							} catch {}
						},
						{ once: true },
					);
				},
				cancel: cleanup,
			},
			{ highWaterMark: 1_000_000, size: (chunk) => chunk?.byteLength ?? 0 },
		);
		return c.body(stream, 200, SSE_HEADERS);
	});
}
