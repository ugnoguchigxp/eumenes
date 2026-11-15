import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { VideoHttpError, isOnDemandBusy } from "../../larm";
import { parseJsonBody } from "../../../infrastructure/http";
import { videoId, videoInput } from "../contracts";
import type { VideoService } from "../service";

const noStore = { "Cache-Control": "no-store" };

function failure(c: Context, error: unknown) {
	if (isOnDemandBusy(error))
		return c.json({ error: error.message }, 409, noStore);
	if (error instanceof VideoHttpError)
		return c.json({ error: error.code }, error.status as ContentfulStatusCode, {
			...noStore,
			...(error.retryAfterMs
				? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) }
				: {}),
		});
	return c.json({ error: "video_connection_failed" }, 502, noStore);
}

export function registerVideo(app: Hono, video: VideoService) {
	const wrap =
		(fn: (c: Context) => Response | Promise<Response>) =>
		async (c: Context) => {
			try {
				return await fn(c);
			} catch (error) {
				return failure(c, error);
			}
		};
	const savedId = (c: Context) => {
		const id = videoId.safeParse(c.req.param("id"));
		if (!id.success) throw new VideoHttpError(404, "video_not_found");
		return id.data;
	};
	const requestId = (c: Context) => {
		const id = z.uuid().safeParse(c.req.param("id"));
		if (!id.success) throw new VideoHttpError(404, "video_not_found");
		return id.data;
	};
	const signal = (c: Context) => c.req.raw.signal;
	app.get("/api/videos/admission", (c) =>
		c.json(video.admission(), 200, noStore),
	);
	app.get("/api/videos/workspace", (c) =>
		c.json(video.snapshot(), 200, noStore),
	);
	app.get(
		"/api/videos/service",
		wrap(async (c) => {
			return c.json(await video.discover(signal(c)), 200, noStore);
		}),
	);
	app.post(
		"/api/videos/generations",
		wrap(async (c) => {
			const key = z.uuid().safeParse(c.req.header("Idempotency-Key"));
			if (!key.success)
				return c.json({ error: "invalid_idempotency_key" }, 400);
			const input = await parseJsonBody(c, videoInput, {
				code: "invalid_video_request",
			});
			if (!input.ok) return input.response;
			return c.json(await video.submit(key.data, input.data), 202, noStore);
		}),
	);
	app.post(
		"/api/videos/generations/:id/reconcile",
		wrap(async (c) =>
			c.json(await video.reconcile(requestId(c)), 202, noStore),
		),
	);
	app.delete(
		"/api/videos/generations/:id",
		wrap(async (c) =>
			c.json(await video.cancel(requestId(c), signal(c)), 200, noStore),
		),
	);
	app.get(
		"/api/videos",
		wrap(async (c) =>
			c.json({ videos: await video.list(signal(c)) }, 200, noStore),
		),
	);
	app.get(
		"/api/videos/:id/content",
		wrap((c) => video.content(savedId(c), c.req.header("Range"), signal(c))),
	);
	app.get(
		"/api/videos/:id/metadata",
		wrap(async (c) =>
			c.json(await video.metadata(savedId(c), signal(c)), 200, noStore),
		),
	);
	app.delete(
		"/api/videos/:id",
		wrap(async (c) => {
			await video.remove(savedId(c), signal(c));
			return c.body(null, 204, noStore);
		}),
	);
}
