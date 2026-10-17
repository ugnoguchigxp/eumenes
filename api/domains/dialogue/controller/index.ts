import type { Hono } from "hono";
import type { DialogueService } from "..";
import {
	publicSubmitSchema,
	specialistCommandKinds,
	specialistCommandSchema,
	type RunProgress,
} from "../contracts";
import { parseJsonBody } from "../../../infrastructure/http";
import { snapshotStream } from "../../../infrastructure/snapshot-stream";
export { registerCommandInteractions } from "./interactions";
/** HTTP status of each code the specialist operations throw; unknown codes stay 500. */
const specialistErrorStatus = {
	specialist_session_not_found: 404,
	revision_conflict: 409,
	request_conflict: 409,
	session_ended: 409,
	session_expired: 409,
	session_closing: 409,
	session_not_suspended: 409,
	work_unsaved: 409,
	work_busy: 409,
	specialist_unavailable: 503,
	addressee_changed: 409,
} as const;
function specialistError(c: import("hono").Context, error: unknown) {
	const code = error instanceof Error ? error.message : "";
	if (!Object.hasOwn(specialistErrorStatus, code)) throw error;
	return c.json(
		{ error: code },
		specialistErrorStatus[code as keyof typeof specialistErrorStatus],
	);
}
export function registerDialogue(app: Hono, service: DialogueService) {
	app.get("/api/runs/:id/stream", (c) => {
		const id = c.req.param("id");
		if (!service.get(id)) return c.json({ error: "not_found" }, 404);
		return c.body(
			snapshotStream<RunProgress>(
				(listener) => service.subscribeProgress(id, listener),
				(value) => !["queued", "running"].includes(value.status),
				c.req.raw.signal,
			),
			200,
			{
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		);
	});
	app.get("/api/conversations/:id/runs", (c) =>
		c.json(service.list(c.req.param("id"))),
	);
	app.post("/api/runs", async (c) => {
		const parsed = await parseJsonBody(c, publicSubmitSchema);
		if (!parsed.ok) return parsed.response;
		try {
			return c.json(await service.submit(parsed.data), 202);
		} catch (error) {
			// A specialist turn still holds the work: the screen sends again when it is free.
			return specialistError(c, error);
		}
	});
	app.get("/api/conversations/:id/specialist", (c) =>
		c.json({ session: service.specialistSession(c.req.param("id")) }),
	);
	for (const kind of specialistCommandKinds)
		app.post(`/api/specialist-sessions/:id/${kind}`, async (c) => {
			const parsed = await parseJsonBody(c, specialistCommandSchema);
			if (!parsed.ok) return parsed.response;
			try {
				return c.json(
					await service.specialistCommand(c.req.param("id"), kind, parsed.data),
				);
			} catch (error) {
				return specialistError(c, error);
			}
		});
	app.get("/api/runs/:id", (c) => {
		const run = service.get(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/runs/:id/error-report", async (c) => {
		const report = await service.errorReport(c.req.param("id"));
		if (report.ok) return c.json({ runId: report.runId, text: report.text });
		return report.reason === "not_found"
			? c.json({ error: "not_found" }, 404)
			: c.json({ error: "error_report_not_applicable" }, 409);
	});
	app.post("/api/runs/:id/cancel", async (c) => {
		const run = await service.cancel(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
}
