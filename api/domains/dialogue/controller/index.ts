import type { Hono } from "hono";
import type { DialogueService } from "..";
import {
	publicSubmitSchema,
	resubmitSchema,
	specialistCommandKinds,
	specialistCommandSchema,
	specialistRetargetSchema,
	todoNoticesQuery,
	type RunProgress,
} from "../contracts";
import { parseJsonBody, parseQuery } from "../../../infrastructure/http";
import { snapshotStream } from "../../../infrastructure/snapshot-stream";
import { SSE_HEADERS } from "../../../infrastructure/sse";
export { registerCommandInteractions } from "./interactions";
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
			SSE_HEADERS,
		);
	});
	app.get("/api/conversations/:id/runs", (c) =>
		c.json(service.list(c.req.param("id"))),
	);
	app.get("/api/conversations/:id/resources", (c) =>
		c.json(service.conversationResources(c.req.param("id"))),
	);
	app.post("/api/conversations/:id/recent/clear", async (c) => {
		if (!(await service.clearRecent(c.req.param("id"))))
			return c.json({ error: "conversation_busy" }, 409);
		return c.json({ ok: true });
	});
	app.get("/api/todo-notices", (c) => {
		const query = parseQuery(c, todoNoticesQuery, { code: "invalid_input" });
		if (!query.ok) return query.response;
		return c.json(service.todoNotices(query.data.limit));
	});
	app.post("/api/todo-notices/archive", async (c) => {
		await service.archiveTodoNotices();
		return c.body(null, 204);
	});
	app.post("/api/todo-notices/:id/read", async (c) => {
		if (!(await service.readTodoNotice(c.req.param("id"))))
			return c.json({ error: "work_not_found" }, 404);
		return c.json({ ok: true });
	});
	app.post("/api/runs", async (c) => {
		const parsed = await parseJsonBody(c, publicSubmitSchema);
		if (!parsed.ok) return parsed.response;
		// A specialist turn still holds the work: the screen sends again when it is free.
		return c.json(await service.submit(parsed.data), 202);
	});
	app.post(
		"/api/conversations/:conversationId/messages/:messageId/resubmit",
		async (c) => {
			const parsed = await parseJsonBody(c, resubmitSchema);
			if (!parsed.ok) return parsed.response;
			const result = await service.resubmit(
				c.req.param("conversationId"),
				c.req.param("messageId"),
				parsed.data,
			);
			if (result.ok) return c.json({ run: result.run });
			return c.json(
				{ error: result.code },
				result.code === "not_found"
					? 404
					: result.code === "empty_text"
						? 400
						: 409,
			);
		},
	);
	app.get("/api/conversations/:id/specialist", (c) =>
		c.json({ session: service.specialistSession(c.req.param("id")) }),
	);
	for (const kind of specialistCommandKinds)
		app.post(`/api/specialist-sessions/:id/${kind}`, async (c) => {
			const parsed = await parseJsonBody(c, specialistCommandSchema);
			if (!parsed.ok) return parsed.response;
			return c.json(
				await service.specialistCommand(c.req.param("id"), kind, parsed.data),
			);
		});
	app.post("/api/specialist-sessions/:id/retarget", async (c) => {
		const parsed = await parseJsonBody(c, specialistRetargetSchema);
		if (!parsed.ok) return parsed.response;
		return c.json(
			await service.specialistRetarget(c.req.param("id"), parsed.data),
		);
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
