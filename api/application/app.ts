import { getLogger, withLogContext } from "../infrastructure/logger";
import { limitConcurrency } from "../infrastructure/concurrency";
import { Hono } from "hono";
import { statusForError } from "./error-status";
import { createHash, timingSafeEqual } from "node:crypto";
import { appModules, type AppModule, type AppServices } from "./app-modules";
const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) =>
	timingSafeEqual(digest(a), digest(b));
const maxJsonBytes = 1024 * 1024;
/**
 * Routes that read their body through their own bounded streaming reader
 * (`readBounded`, 4MB). The global Content-Length cap must not pre-empt them.
 * Exact path match only; never a prefix.
 */
const streamBoundedRoutes = new Set([
	"/api/voice/turns",
	"/api/voice/preview",
	"/api/service-tests/uploads",
]);

export type AppOptions = {
	token: string;
	origin: string;
	/** Route groups, mounted in order after the shared middleware. */
	modules: readonly AppModule[];
};
/**
 * @deprecated Older compositions pass the services directly; they are turned
 * into modules with `appModules`. New code passes `modules`.
 */
type LegacyAppOptions = Omit<AppOptions, "modules"> & AppServices;

export function createApp(options: AppOptions | LegacyAppOptions) {
	const modules = "modules" in options ? options.modules : appModules(options);
	const app = new Hono();
	const log = getLogger("http");
	app.use("*", async (c, next) => {
		await next();
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		c.header("X-Frame-Options", "DENY");
		// API responses are never rendered as documents, so allow nothing.
		c.header(
			"Content-Security-Policy",
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		);
	});
	app.use("/api/*", async (c, next) => {
		const requestId = crypto.randomUUID();
		const started = performance.now();
		c.header("X-Request-Id", requestId);
		return withLogContext({ httpRequestId: requestId }, async () => {
			log.debug("http.started", { method: c.req.method });
			await next();
			const fields = {
				method: c.req.method,
				route: c.req.routePath,
				status: c.res.status,
				durationMs: Math.round(performance.now() - started),
			};
			if (c.res.status >= 500) log.error("http.completed", fields);
			else if (c.res.status >= 400) log.warn("http.completed", fields);
			else if (c.req.method === "GET") log.debug("http.completed", fields);
			else log.info("http.completed", fields);
		});
	});
	app.use("/api/*", async (c, next) => {
		const origin = c.req.header("origin");
		if (origin && origin !== options.origin)
			return c.json({ error: "origin_forbidden" }, 403);
		if (origin) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Vary", "Origin");
			c.header("Access-Control-Expose-Headers", "X-Request-Id");
			c.header(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type, Last-Event-ID, X-Session-Id, X-Generation, X-Sequence, X-Utterance-Id",
			);
			c.header(
				"Access-Control-Allow-Methods",
				"GET, POST, PUT, PATCH, DELETE, OPTIONS",
			);
		}
		if (c.req.method === "OPTIONS") return c.body(null, 204);
		if (
			!safeEqual(c.req.header("authorization") ?? "", `Bearer ${options.token}`)
		)
			return c.json({ error: "unauthorized" }, 401);
		if (
			c.req.header("content-length") !== undefined &&
			c.req.header("transfer-encoding") !== undefined
		)
			return c.json({ error: "invalid_framing" }, 400);
		if (
			c.req.method !== "GET" &&
			c.req.method !== "HEAD" &&
			!streamBoundedRoutes.has(c.req.path)
		) {
			const length = c.req.header("content-length");
			if (length === undefined) {
				if (c.req.header("transfer-encoding"))
					return c.json({ error: "length_required" }, 411);
			} else if (!(Number(length) <= maxJsonBytes))
				return c.json({ error: "payload_too_large" }, 413);
		}
		await next();
	});
	// Cost guards for endpoints that fan out to providers; never for long-lived streams.
	// Only the slow endpoints share the budget: cancel and retry-artifact must stay
	// reachable while runs are in flight.
	app.on(
		"POST",
		[
			"/api/service-tests/catalog/refresh",
			"/api/service-tests/diagnose",
			"/api/service-tests/runs",
			"/api/service-tests/uploads",
		],
		limitConcurrency(2),
	);
	app.on(
		"POST",
		["/api/voice/replay/audio", "/api/voice/sample"],
		limitConcurrency(2),
	);
	app.on("POST", "/api/inference/probes", limitConcurrency(1));
	for (const module of modules) module.mount(app);
	app.onError((error, c) => {
		const message = error instanceof Error ? error.message : "internal_error";
		const status = statusForError(message);
		// Internal failures never leak details to the client.
		if (status === 500) {
			log.error("http.failed", { reason: "internal_error", status }, error);
			return c.json({ error: "internal_error" }, 500);
		}
		log.warn("http.rejected", { reason: message, status });
		return c.json({ error: message }, status);
	});
	return app;
}
