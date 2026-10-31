import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ComputeService } from "../service";
import { errorStatus, submitInput } from "../contracts";
import { parseJsonBody } from "../../../infrastructure/http";

/** A code with a status of its own reaches the application's error handler; anything else is unavailable. */
function failed(c: Context, e: unknown) {
	if (e instanceof z.ZodError || e instanceof SyntaxError)
		return c.json({ error: "invalid_request" }, 400);
	if (e instanceof Error && Object.hasOwn(errorStatus, e.message)) throw e;
	return c.json({ error: "compute_service_unavailable" }, 503);
}
/** Authentication and Origin checks are the application's existing middleware. */
export function registerCompute(
	app: Hono,
	service: ComputeService,
	owner: string,
) {
	app.use(
		"/api/compute/*",
		bodyLimit({
			maxSize: 2 * 1024 * 1024,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.get("/api/compute/jobs", (c) =>
		c.json({ jobs: service.list(owner) }, 200, { "Cache-Control": "no-store" }),
	);
	app.post("/api/compute/jobs", async (c) => {
		const key = z.uuid().safeParse(c.req.header("Idempotency-Key"));
		if (!key.success) return c.json({ error: "invalid_request" }, 400);
		const input = await parseJsonBody(c, submitInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(
				await service.submit(owner, "main", input.data, key.data),
				202,
			);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.get("/api/compute/jobs/:id", (c) => {
		try {
			return c.json(
				service.get(owner, z.uuid().parse(c.req.param("id"))),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.post("/api/compute/jobs/:id/cancel", async (c) => {
		try {
			return c.json(
				await service.cancel(owner, z.uuid().parse(c.req.param("id"))),
				202,
			);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.post("/api/compute/jobs/:id/reconcile", async (c) => {
		try {
			return c.json(
				await service.reconcile(owner, z.uuid().parse(c.req.param("id"))),
				202,
			);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.delete("/api/compute/jobs/:id", async (c) => {
		try {
			const job = await service.delete(
				owner,
				z.uuid().parse(c.req.param("id")),
			);
			return job.state === "deleted" ? c.body(null, 204) : c.json(job, 202);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.get("/api/compute/jobs/:id/artifacts/:artifactId", (c) => {
		try {
			const a = service.artifact(
				owner,
				z.uuid().parse(c.req.param("id")),
				z.uuid().parse(c.req.param("artifactId")),
			);
			return new Response(new Uint8Array(a.content), {
				headers: {
					"Content-Type": a.mime,
					"Content-Length": String(a.content.byteLength),
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": "sandbox; default-src 'none'",
					"Content-Disposition": `${a.mime === "image/png" ? "inline" : "attachment"}; filename="artifact"; filename*=UTF-8''${encodeURIComponent(a.name).replace(/'/g, "%27")}`,
				},
			});
		} catch (e) {
			return failed(c, e);
		}
	});
}
