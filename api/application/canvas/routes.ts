import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canvasFile, canvasOwner, type CanvasRuntime } from "./runtime";
import type { CanvasJobs } from "./jobs";
import { answerError } from "../app";

const root = "/api/canvas";
const assets = join(import.meta.dir, "../../../vendor/canvas/workbench");
const workbench = join(import.meta.dir, "workbench");
const name = z.string().regex(/^[a-z]_[a-zA-Z0-9_-]{12}$/);
const version = z.number().int().min(1);
const key = z.string().min(8).max(100);
const message = z.string().trim().min(1).max(4000);
const runInput = z
	.strictObject({
		message,
		artworkId: name.nullish(),
		conversation: z
			.array(
				z.strictObject({ role: z.enum(["user", "assistant"]), text: message }),
			)
			.max(20)
			.optional(),
		requestKey: key.optional(),
		expectedBase: z
			.strictObject({
				revision: version,
				digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
			})
			.optional(),
	})
	.refine(
		(input) => !input.artworkId || !!input.expectedBase,
		"編集元の版が必要です",
	);

function workbenchScript() {
	const script = readFileSync(join(assets, "app.js"), "utf8")
		.replaceAll('from "/', 'from "./')
		.replace(/^window\.__canvasHost = .*$/m, "")
		.replace(
			"state.mode = mode;",
			'state.mode = mode; parent.postMessage({ type: "eumenes-canvas-mode", mode }, location.origin);',
		)
		.replace(
			'e.key === "Escape" && state.mode !== "frame"',
			'e.key === "Escape" && state.mode !== "frame" && !document.querySelector("[popover]:popover-open")',
		)
		.replace('fetch("/api/config")', 'fetch("../config")')
		.replace("fetch(path, {", 'fetch("/api/canvas" + path.slice(4), {')
		.replace(
			'sessionStorage.getItem("canvas-session")',
			'sessionStorage.getItem("eumenes-canvas-session")',
		)
		.replace(
			'sessionStorage.setItem("canvas-session", session)',
			'sessionStorage.setItem("eumenes-canvas-session", session)',
		);
	const bootstrap = "ctl.mount().catch(() => {});";
	if (!script.includes(bootstrap))
		throw new Error("canvas_workbench_bootstrap_missing");
	const install = `installCanvasJobs({ conversationId: new URLSearchParams(location.search).get("conversationId"), api, $, state, getSelection: () => selection, hideCandidate, setRunStatus, notice, openArtwork, selectArtwork, pollRun, STATE_TEXT });`;
	return (
		// Install operation tracking before the first asynchronous list refresh.
		script.replace(bootstrap, install + "\n" + bootstrap) +
		"\n" +
		readFileSync(join(workbench, "jobs.js"), "utf8").replace(
			"export function",
			"function",
		)
	);
}

export function registerCanvasRoutes(
	parent: Hono,
	runtime: CanvasRuntime,
	jobs: CanvasJobs,
) {
	const app = new Hono();
	// Hono handles route exceptions before returning through middleware.
	app.onError((error, c) => {
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return c.json({ error: "入力の形式を確認してください" }, 400);
		if (runtime.isServiceError(error))
			return new Response(
				JSON.stringify({ error: error.message, ...error.extra }),
				{
					status: error.status,
					headers: {
						"content-type": "application/json",
						"cache-control": "no-store",
					},
				},
			);
		return answerError(error, c);
	});
	app.use(`${root}/*`, bodyLimit({ maxSize: 256 * 1024 }));
	app.use(`${root}/*`, async (c, next) => {
		if (c.req.method !== "GET" && c.req.header("Origin") !== runtime.hostOrigin)
			return c.json({ error: "操作元が一致しません" }, 403);
		try {
			await runtime.start(c.req.raw.signal);
			c.req.raw.signal.throwIfAborted();
		} catch {
			return c.json({ error: "Canvasアプリが起動していません" }, 503);
		}
		await next();
	});
	app.get(`${root}/workbench/index.html`, (c) => {
		c.header(
			"Content-Security-Policy",
			`default-src 'self'; frame-src ${runtime.previewOrigin}; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`,
		);
		c.header("X-Frame-Options", "SAMEORIGIN");
		c.header("Cache-Control", "no-store");
		return c.html(readFileSync(join(workbench, "index.html"), "utf8"));
	});
	app.get(`${root}/workbench/app.css`, (c) =>
		c.body(readFileSync(join(workbench, "app.css"), "utf8"), 200, {
			"Content-Type": "text/css",
		}),
	);
	app.get(`${root}/workbench/app.js`, (c) =>
		c.body(workbenchScript(), 200, {
			"Content-Type": "text/javascript",
			"Cache-Control": "no-store",
		}),
	);
	// Eumenes keeps Canvas diagnostics out of the general application log.
	app.get(`${root}/workbench/client-log.js`, (c) =>
		c.body("export function clog() {}", 200, {
			"Content-Type": "text/javascript",
		}),
	);
	app.get(`${root}/workbench/preview-client.js`, (c) =>
		c.body(
			canvasFile("src/host/preview-client.js").replace(
				'from "/shared/messages.js"',
				'from "./shared/messages.js"',
			),
			200,
			{ "Content-Type": "text/javascript" },
		),
	);
	app.get(`${root}/workbench/shared/messages.js`, (c) =>
		c.body(canvasFile("src/shared/messages.js"), 200, {
			"Content-Type": "text/javascript",
		}),
	);
	app.get(`${root}/config`, (c) =>
		c.json({
			hostOrigin: runtime.hostOrigin,
			previewOrigin: runtime.previewOrigin,
			artworkSearch: true,
			inputVersion: 2,
		}),
	);
	app.get(`${root}/jobs/latest`, (c) => {
		const conversationId = z
			.string()
			.min(1)
			.max(128)
			.parse(c.req.query("conversationId"));
		const row = jobs.latest(conversationId);
		const raw = row ? jobs.runOf(row.id) : null;
		const run = raw ? jobs.visibleRun(raw.id) : null;
		const unavailable =
			row?.state === "completed" &&
			run?.state === "failed" &&
			raw?.state === "presented";
		return c.json(
			row && {
				id: row.id,
				state: unavailable ? "failed" : row.state,
				acceptedAt: row.createdAtMs,
				runId: run?.id ?? null,
				runState: run?.state ?? null,
				errorCode: unavailable ? "canvas_source_changed" : row.errorCode,
			},
		);
	});
	app.post(`${root}/jobs/:id/cancel`, async (c) => {
		await jobs.cancel(c.req.param("id"));
		return c.json({ ok: true });
	});
	app.post(`${root}/runs`, async (c) => {
		const session = z
			.string()
			.regex(/^[a-zA-Z0-9_-]{8,64}$/)
			.parse(c.req.header("x-canvas-session"));
		const body = runInput.parse(await c.req.json());
		return c.json(
			await runtime.service.startRun(canvasOwner, session, body),
			201,
		);
	});
	app.get(`${root}/runs/:id`, (c) =>
		c.json(jobs.visibleRun(c.req.param("id"))),
	);
	app.post(`${root}/runs/:id/cancel`, async (c) =>
		c.json(await runtime.service.cancelRun(canvasOwner, c.req.param("id"))),
	);
	app.get(`${root}/artworks`, (c) =>
		c.json(runtime.service.listArtworks(canvasOwner)),
	);
	app.get(`${root}/artwork-search`, (c) => {
		const query = z
			.strictObject({
				conversationId: z.string().min(1).max(128),
				query: z.string().max(200).optional(),
				cursor: z.string().max(1024).optional(),
			})
			.parse(c.req.query());
		return c.json(
			runtime.service.catalog.page(canvasOwner, query.conversationId, query),
		);
	});
	app.get(`${root}/artworks/:id`, (c) =>
		c.json(runtime.service.getArtwork(canvasOwner, c.req.param("id"))),
	);
	app.post(`${root}/artworks/:id/restore`, async (c) => {
		const body = z
			.strictObject({
				revision: version,
				expectedRevision: version,
				idempotencyKey: key,
			})
			.parse(await c.req.json());
		const result = await runtime.service.restore(
			canvasOwner,
			c.req.param("id"),
			body,
		);
		return new Response(
			JSON.stringify({ ...(result.result as object), replay: result.replay }),
			{
				status: result.status,
				headers: { "content-type": "application/json" },
			},
		);
	});
	app.post(`${root}/candidates/:id/save`, async (c) => {
		const body = z
			.strictObject({
				expectedRevision: z.number().int().min(0),
				idempotencyKey: key,
			})
			.parse(await c.req.json());
		const result = await runtime.service.save(
			canvasOwner,
			c.req.param("id"),
			body,
		);
		return new Response(
			JSON.stringify({ ...(result.result as object), replay: result.replay }),
			{
				status: result.status,
				headers: { "content-type": "application/json" },
			},
		);
	});
	app.post(`${root}/previews`, async (c) => {
		const source = z
			.union([
				z.strictObject({ candidateId: name }),
				z.strictObject({ artworkId: name, revision: version.optional() }),
			])
			.parse(await c.req.json());
		const { body, data } = runtime.service.resolvePreview(canvasOwner, source);
		return c.json({ token: runtime.issue(body), title: body.title, data });
	});
	parent.route("/", app);
}
