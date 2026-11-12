import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceError } from "eumenes-canvas/src/core/service";
import { canvasFile, canvasOwner, type CanvasRuntime } from "./runtime";
import type { CanvasJobs } from "./jobs";

const root = "/api/canvas";
const assets = join(import.meta.dir, "../../../vendor/canvas/workbench");
const workbench = join(import.meta.dir, "workbench");
const name = z.string().regex(/^[a-z]_[a-zA-Z0-9_-]{12}$/);
const version = z.number().int().min(1);
const key = z.string().min(8).max(100);
const message = z.string().trim().min(1).max(4000);
const runInput = z.strictObject({
	message,
	artworkId: name.nullish(),
	conversation: z
		.array(
			z.strictObject({ role: z.enum(["user", "assistant"]), text: message }),
		)
		.max(20)
		.optional(),
});

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
	return (
		script +
		`

const canvasConversation = new URLSearchParams(location.search).get("conversationId");
let canvasJob = null;
let lastCanvasRun = null;
$("cancel").addEventListener("click", (event) => {
  if (!canvasJob || state.runId) return;
  event.stopImmediatePropagation();
  void api("/api/jobs/" + encodeURIComponent(canvasJob.id) + "/cancel", { method: "POST", body: {} })
    .catch(() => notice("取り消せませんでした。"));
}, true);
if (canvasConversation) {
  async function pollCanvasJob() {
    try {
      const job = await api("/api/jobs/latest?conversationId=" + encodeURIComponent(canvasConversation), { quiet: true });
      if (state.runId || !job) return;
      if (job.state === "queued" || job.state === "running") {
        if (!canvasJob || canvasJob.id !== job.id) {
          hideCandidate();
          setRunStatus("Eumenesから受け付けた依頼を制作中…");
          $("cancel").disabled = false;
        }
        canvasJob = job;
        return;
      }
      const previous = canvasJob;
      canvasJob = null;
      if (job.state === "completed" && job.runId && job.runId !== lastCanvasRun) {
        const run = await api("/api/runs/" + encodeURIComponent(job.runId), { quiet: true });
        if (state.runId) return;
        lastCanvasRun = job.runId;
        if (run.state !== "presented") return;
        if (!run.isNew) await openArtwork(run.artworkId);
        else selectArtwork(null);
        state.runId = run.id;
        pollRun(run.id);
      } else if (previous?.id === job.id && job.state !== "completed") {
        $("cancel").disabled = true;
        setRunStatus(STATE_TEXT[job.state] || "制作を完了できませんでした");
      }
    } catch {
      // The next poll may recover. The host keeps the current work visible.
    } finally {
      setTimeout(pollCanvasJob, 1000);
    }
  }
  void pollCanvasJob();
}
`
	);
}

export function registerCanvasRoutes(
	app: Hono,
	runtime: CanvasRuntime,
	jobs: CanvasJobs,
) {
	app.use(`${root}/*`, bodyLimit({ maxSize: 256 * 1024 }));
	app.use(`${root}/*`, async (c, next) => {
		if (!runtime.ready())
			return c.json({ error: "Canvasアプリが起動していません" }, 503);
		if (c.req.method !== "GET" && c.req.header("Origin") !== runtime.hostOrigin)
			return c.json({ error: "操作元が一致しません" }, 403);
		try {
			await next();
		} catch (error) {
			if (error instanceof z.ZodError || error instanceof SyntaxError)
				return c.json({ error: "入力の形式を確認してください" }, 400);
			if (error instanceof ServiceError)
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
			throw error;
		}
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
		c.body(workbenchScript(), 200, { "Content-Type": "text/javascript" }),
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
		}),
	);
	app.get(`${root}/jobs/latest`, (c) => {
		const conversationId = z
			.string()
			.min(1)
			.max(128)
			.parse(c.req.query("conversationId"));
		const row = jobs.latest(conversationId);
		return c.json(
			row && {
				id: row.id,
				state: row.state,
				runId: row.state === "completed" ? row.resultRef : null,
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
		c.json(runtime.service.getRun(canvasOwner, c.req.param("id"))),
	);
	app.post(`${root}/runs/:id/cancel`, async (c) =>
		c.json(await runtime.service.cancelRun(canvasOwner, c.req.param("id"))),
	);
	app.get(`${root}/artworks`, (c) =>
		c.json(runtime.service.listArtworks(canvasOwner)),
	);
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
}
