import { mkdirSync } from "node:fs";
import {
	CanvasService,
	MAX_FIX_ATTEMPTS,
	ServiceError,
	type CandidateAccess,
} from "eumenes-canvas/src/core/service";
import { Store } from "eumenes-canvas/src/core/store";
import { PlaywrightObserver } from "eumenes-canvas/src/core/observer";
import { PromptMaker } from "eumenes-canvas/src/core/prompt-maker";
import { PromptEvaluator } from "eumenes-canvas/src/core/prompt-evaluator";
import { PlaywrightProber } from "eumenes-canvas/src/core/probes";
import { HostReviewer } from "eumenes-canvas/src/core/host-reviewer";
import {
	PreviewTokens,
	previewHandler,
} from "eumenes-canvas/src/server/preview";
import { makerChannel } from "./maker-channel";
import {
	canvasFile,
	type CanvasInstance,
	type CanvasRuntimeOptions,
} from "./runtime";

const harnessAssets = {
	"/harness.html": ["src/host/harness.html", "text/html"],
	"/harness.js": ["src/host/harness.js", "text/javascript"],
	"/harness.css": ["src/host/harness.css", "text/css"],
	"/preview-client.js": ["src/host/preview-client.js", "text/javascript"],
	"/shared/messages.js": ["src/shared/messages.js", "text/javascript"],
} as const;

function scopePreview(host: string, origin: string, tokens: PreviewTokens) {
	const fetch = previewHandler({ hostOrigin: host, tokens });
	return (req: Request) =>
		new URL(req.url).origin === origin
			? fetch(req)
			: new Response(null, { status: 421 });
}

type CanvasListen = (options: {
	hostname: string;
	port: number;
	fetch(req: Request): Response | Promise<Response>;
}) => {
	port: number | undefined;
	stop(closeActiveConnections: boolean): Promise<void>;
};

export async function launchCanvas(
	options: CanvasRuntimeOptions,
	candidateAccess: CandidateAccess,
	listen: CanvasListen = (options) => Bun.serve(options),
): Promise<CanvasInstance> {
	const tokens = new PreviewTokens();
	const observationTokens = new PreviewTokens();
	const listeners: Array<ReturnType<CanvasListen>> = [];
	let service: CanvasService | undefined;
	const close = async () => {
		const results = await Promise.allSettled([
			...listeners.splice(0).map(async (listener) => listener.stop(true)),
			Promise.resolve().then(() => service?.close()),
		]);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	};
	const origin = new URL(options.previewOrigin);
	try {
		const fetch = scopePreview(options.hostOrigin, origin.origin, tokens);
		const port = Number(origin.port);
		listeners.push(listen({ hostname: "127.0.0.1", port, fetch }));
		if (origin.hostname === "localhost")
			listeners.push(listen({ hostname: "::1", port, fetch }));
		let observedHost = "";
		let observedPreview = "";
		const harness = listen({
			hostname: "::1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.origin !== observedHost || req.method !== "GET")
					return new Response(null, { status: 404 });
				if (url.pathname === "/api/config")
					return Response.json({
						previewOrigin: observedPreview,
						hostOrigin: observedHost,
					});
				const key = url.pathname as keyof typeof harnessAssets;
				if (!Object.hasOwn(harnessAssets, key))
					return new Response(null, { status: 404 });
				const [file, contentType] = harnessAssets[key];
				return new Response(canvasFile(file), {
					headers: {
						"content-type": contentType,
						"content-security-policy": `default-src 'self'; frame-src ${observedPreview}; frame-ancestors 'none'`,
						"cache-control": "no-store",
					},
				});
			},
		});
		listeners.push(harness);
		if (harness.port === undefined)
			throw new Error("canvas_listener_unavailable");
		observedHost = `http://localhost:${harness.port}`;
		const observation = listen({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				return scopePreview(
					observedHost,
					observedPreview,
					observationTokens,
				)(req);
			},
		});
		listeners.push(observation);
		if (observation.port === undefined)
			throw new Error("canvas_listener_unavailable");
		observedPreview = `http://127.0.0.1:${observation.port}`;
		mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
		service = new CanvasService({
			candidateAccess,
			modelCallLimit: (MAX_FIX_ATTEMPTS + 1) * 2,
			store: new Store(options.dataDir),
			model: new PromptMaker(makerChannel(options.store, options.inference)),
			observer: new PlaywrightObserver(
				observedHost,
				(body) => observationTokens.issue(body),
				[],
				false,
			),
			contract: canvasFile("docs/artwork-contract-v1.md"),
			review: {
				mode: "judge",
				maxReviews: MAX_FIX_ATTEMPTS + 1,
				reviewer: new HostReviewer(
					new PlaywrightProber(
						observedHost,
						(body) => observationTokens.issue(body),
						[],
						false,
					),
					new PromptEvaluator(makerChannel(options.store, options.inference)),
				),
			},
		});
		return {
			service,
			issue: tokens.issue.bind(tokens),
			isServiceError: (error): error is ServiceError =>
				error instanceof ServiceError,
			close,
		};
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}
