import type { Hono } from "hono";
import type { VideoService } from "../../domains/video";

/** Reject new interactive work while an Eumenes video is in flight on the saved Control. */
export function registerVideoAdmission(app: Hono, video: VideoService) {
	const routes = [
		"/api/runs",
		"/api/conversations/:conversationId/messages/:messageId/resubmit",
		"/api/voice/sessions",
		"/api/voice/turns",
		"/api/voice/turns/:id/commit",
		"/api/live/sessions",
		"/api/music/:id/artwork",
		"/api/model3d/generations",
		"/api/compute/jobs",
	];
	app.on("POST", routes, async (c, next) => {
		const { state } = video.admission();
		if (state === "active" || state === "unconfirmed")
			return c.json({ error: "on_demand_busy" }, 409);
		// LARM decides whether isolation has cleared since its last video status.
		await next();
	});
}
