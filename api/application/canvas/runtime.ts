import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CanvasService } from "eumenes-canvas/src/core/service";
import { Store } from "eumenes-canvas/src/core/store";
import { PlaywrightObserver } from "eumenes-canvas/src/core/observer";
import { PromptMaker } from "eumenes-canvas/src/core/prompt-maker";
import type { InferenceChannel } from "eumenes-canvas/src/core/inference";
import {
	PreviewTokens,
	previewHandler,
} from "eumenes-canvas/src/server/preview";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation";
import type { InferencePort } from "../../domains/inference";
import { agentSystemMessage } from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";

const pkg = dirname(
	createRequire(import.meta.url).resolve("eumenes-canvas/package.json"),
);
export const canvasFile = (path: string) =>
	readFileSync(join(pkg, path), "utf8");
export const canvasOwner = CONVERSATION_DEFAULT_PRINCIPAL;

export function canvasPreviewOrigin(
	hostOrigin: string,
	portValue?: string,
): string | null {
	if (!portValue?.trim()) return null;
	const port = Number(portValue);
	const host = new URL(hostOrigin);
	if (
		!/^\d+$/.test(portValue.trim()) ||
		!Number.isSafeInteger(port) ||
		port < 1024 ||
		port > 65535 ||
		host.protocol !== "http:" ||
		host.origin !== hostOrigin ||
		!["localhost", "127.0.0.1"].includes(host.hostname)
	)
		throw new Error("config_invalid:EUMENES_CANVAS_PREVIEW_PORT");
	return `http://${host.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${port}`;
}

export function makerChannel(
	store: SqliteStore,
	inference: Pick<
		InferencePort,
		"captureUserControlInTransaction" | "executeControl"
	>,
): InferenceChannel {
	return {
		async complete(request, validate, signal) {
			const capture = inference.captureUserControlInTransaction;
			const execute = inference.executeControl;
			if (!capture || !execute) throw new Error("canvas_inference_unavailable");
			signal.throwIfAborted();
			const id = await store.write((db) => {
				signal.throwIfAborted();
				return capture(db, {
					subject: `canvas-maker:${randomUUID()}`,
					route: "subagent",
					deadline: Date.now() + 90_000,
					maxOutputTokens: 8192,
				});
			});
			const control = {
				instructions: request.system,
				outputSchema: request.outputSchema,
			};
			const reply = await execute(
				id,
				[
					agentSystemMessage(control),
					{ role: "user", content: request.prompt },
				],
				signal,
				control,
			).catch(() => {
				signal.throwIfAborted();
				throw new Error("canvas_inference_failed");
			});
			signal.throwIfAborted();
			try {
				if (typeof reply.value === "string") {
					const checked = validate(JSON.parse(reply.value));
					if (checked.ok) return checked.value;
				}
			} catch {
				// Model output can contain source text. Report only the invalid-output code.
			}
			throw new Error("canvas_invalid_model_output");
		},
	};
}

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

export function createCanvasRuntime(options: {
	hostOrigin: string;
	previewOrigin: string;
	dataDir: string;
	store: SqliteStore;
	inference: InferencePort;
}) {
	const tokens = new PreviewTokens();
	const observationTokens = new PreviewTokens();
	let service: CanvasService | undefined;
	const listeners: Array<{
		stop(closeActiveConnections?: boolean): Promise<void>;
	}> = [];
	const stop = async () => {
		const closing = listeners.splice(0).map((listener) => listener.stop(true));
		await Promise.all([service?.close(), ...closing]);
	};
	return {
		previewOrigin: options.previewOrigin,
		hostOrigin: options.hostOrigin,
		get service() {
			if (!service) throw new Error("canvas_unavailable");
			return service;
		},
		issue: tokens.issue.bind(tokens),
		ready: () => service !== undefined,
		async start() {
			const origin = new URL(options.previewOrigin);
			try {
				const fetch = scopePreview(options.hostOrigin, origin.origin, tokens);
				const port = Number(origin.port);
				listeners.push(Bun.serve({ hostname: "127.0.0.1", port, fetch }));
				if (origin.hostname === "localhost")
					listeners.push(Bun.serve({ hostname: "::1", port, fetch }));
				let observedHost = "";
				let observedPreview = "";
				const harness = Bun.serve({
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
				observedHost = `http://localhost:${harness.port}`;
				const observation = Bun.serve({
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
				observedPreview = `http://127.0.0.1:${observation.port}`;
				mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
				service = new CanvasService({
					store: new Store(options.dataDir),
					model: new PromptMaker(
						makerChannel(options.store, options.inference),
					),
					observer: new PlaywrightObserver(
						observedHost,
						(body) => observationTokens.issue(body),
						[],
						false,
					),
					contract: canvasFile("docs/artwork-contract-v1.md"),
				});
			} catch (error) {
				await stop();
				throw error;
			}
		},
		close: stop,
	};
}

export type CanvasRuntime = ReturnType<typeof createCanvasRuntime>;
