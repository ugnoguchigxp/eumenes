/** ブラウザーE2EとのJSONL通信。ネットワークの待受は起動しない。 */
import { resolve } from "node:path";
import { previewHandler } from "eumenes-canvas/src/server/preview";
import { PlaywrightObserver } from "eumenes-canvas/src/core/observer";
import {
	canvasFixture,
	canvasFixtureOutput,
} from "../api/application/canvas/canvas.fixture";
import {
	canvasHarness,
	routeObservationBrowser,
} from "../api/application/canvas/canvas-browser.fixture";

let failNext = false;
const f = canvasFixture({
	model: {
		label: "fixture",
		async generate(input) {
			if (failNext) {
				failNext = false;
				throw new Error("fixture_failure");
			}
			return {
				...structuredClone(canvasFixtureOutput),
				body: { ...canvasFixtureOutput.body, title: input.request },
			};
		},
	},
});
const { hostOrigin, previewOrigin } = f.runtime;
const preview = previewHandler({ hostOrigin, tokens: f.tokens });
const build = await Bun.build({
	entrypoints: [
		resolve(import.meta.dir, "../tests/browser/canvas-app.fixture.tsx"),
	],
	target: "browser",
	minify: true,
	plugins: [
		{
			name: "local-design-system",
			setup(builder) {
				builder.onResolve({ filter: /^@eumenes\/design-system$/ }, () => ({
					path: resolve(
						import.meta.dir,
						"../packages/design-system/src/index.ts",
					),
				}));
			},
		},
	],
	define: { "process.env.NODE_ENV": '"production"' },
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const js = build.outputs.find((item) => item.path.endsWith(".js"))!;
const css = build.outputs.find((item) => item.path.endsWith(".css"));
const assets = { js: await js.text(), css: css ? await css.text() : "" };
async function dispatch(request: Request) {
	const url = new URL(request.url);
	if (url.origin === previewOrigin) return preview(request);
	if (url.origin !== hostOrigin) return new Response(null, { status: 404 });
	if (url.pathname === "/")
		return new Response(
			'<!doctype html><html lang="ja"><meta charset="utf-8"><title>Canvasブラウザー検証</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}#root{min-height:100dvh}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
			{ headers: { "content-type": "text/html" } },
		);
	if (url.pathname === "/fixture.js")
		return new Response(assets.js, {
			headers: { "content-type": "text/javascript" },
		});
	if (url.pathname === "/fixture.css")
		return new Response(assets.css, {
			headers: { "content-type": "text/css" },
		});
	const harness = canvasHarness(request, hostOrigin, previewOrigin);
	if (harness) return harness;
	const headers = new Headers(request.headers);
	headers.set("authorization", "Bearer canvas-fixture");
	return f.app.request(new Request(request, { headers }));
}
const restoreBrowser = routeObservationBrowser(dispatch);
const observer = new PlaywrightObserver(hostOrigin, (body) =>
	f.tokens.issue(body),
);
f.queue.start();
console.log(JSON.stringify({ ready: true, hostOrigin, previewOrigin }));
try {
	for await (const line of console) {
		const message = JSON.parse(line) as {
			id: number;
			op: string;
			url?: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
			conversationId?: string;
			count?: number;
			entry?: string;
			controls?: Parameters<PlaywrightObserver["observe"]>[3];
		};
		try {
			let result: unknown;
			if (message.op === "http") {
				const response = await dispatch(
					new Request(message.url!, {
						method: message.method,
						headers: message.headers,
						body: message.body,
					}),
				);
				result = {
					status: response.status,
					headers: Object.fromEntries(response.headers),
					body: Buffer.from(await response.arrayBuffer()).toString("base64"),
				};
			} else if (message.op === "seed") {
				for (let n = 0; n < (message.count ?? 1); n++)
					await f.save("保存作品" + String(n).padStart(2, "0"));
				result = { count: f.service.listArtworks("local:owner").length };
			} else if (message.op === "failure" || message.op === "complete") {
				failNext = message.op === "failure";
				const id = await f.source(
					"制作失敗の検証",
					undefined,
					message.conversationId,
				);
				const job = await f.invoke(id, {}, undefined, {
					kind: "conversation",
					owner: { rootRunId: "fixture", taskId: "fixture", cancelEpoch: 0 },
					runId: "fixture",
					conversationId: message.conversationId!,
					messageId: id,
				});
				await f.until(
					() =>
						f.jobs.job(job.id)?.state ===
						(message.op === "failure" ? "failed" : "completed"),
				);
				result = { jobId: job.id, runId: f.jobs.runOf(job.id)?.id };
			} else if (message.op === "observe") {
				result = await observer.observe(
					{ title: "操作応答の検証", entry: message.entry! },
					null,
					new AbortController().signal,
					message.controls ?? [
						{
							kind: "key",
							input: "ArrowRight",
							action: "右へ移動",
							always: true,
						},
					],
				);
			} else if (message.op === "close") break;
			else throw new Error("unknown_fixture_operation");
			console.log(JSON.stringify({ id: message.id, result }));
		} catch (error) {
			console.log(
				JSON.stringify({
					id: message.id,
					error: error instanceof Error ? error.message : "fixture_error",
				}),
			);
		}
	}
} finally {
	await observer.close();
	restoreBrowser();
	await f.close();
}
