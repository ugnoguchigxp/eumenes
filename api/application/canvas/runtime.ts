import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	CanvasService,
	CandidateAccess,
	ServiceError,
} from "eumenes-canvas/src/core/service";
import type { PreviewTokens } from "eumenes-canvas/src/server/preview";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation";
import type { InferencePort } from "../../domains/inference";
import { getLogger } from "../../infrastructure/logger";
import { waitForShared } from "../../infrastructure/wait-for-shared";
import type { SqliteStore } from "../../infrastructure/sqlite";

const log = getLogger("canvas");
let pkg: string | undefined;
export function canvasFile(path: string) {
	pkg ??= dirname(
		createRequire(import.meta.url).resolve("eumenes-canvas/package.json"),
	);
	return readFileSync(join(pkg, path), "utf8");
}
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

export type CanvasRuntimeOptions = {
	hostOrigin: string;
	previewOrigin: string;
	dataDir: string;
	store: SqliteStore;
	inference: Pick<
		InferencePort,
		"captureUserControlInTransaction" | "executeControl"
	>;
};

export type CanvasInstance = {
	service: CanvasService;
	issue: PreviewTokens["issue"];
	isServiceError(error: unknown): error is ServiceError;
	close(): Promise<void>;
};

type CanvasLoader = (
	options: CanvasRuntimeOptions,
	access: CandidateAccess,
	signal: AbortSignal,
) => Promise<CanvasInstance>;

const loadCanvas: CanvasLoader = async (options, access, signal) => {
	const { launchCanvas } = await import("./runtime-server");
	signal.throwIfAborted();
	return launchCanvas(options, access);
};

export function createCanvasRuntime(
	options: CanvasRuntimeOptions,
	load: CanvasLoader = loadCanvas,
) {
	let instance: CanvasInstance | undefined;
	let candidateAccess: CandidateAccess | undefined;
	let opening: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const shutdown = new AbortController();
	const current = () => {
		shutdown.signal.throwIfAborted();
		if (!instance) throw new Error("canvas_unavailable");
		return instance;
	};
	async function open() {
		const started = performance.now();
		try {
			shutdown.signal.throwIfAborted();
			instance = await load(
				options,
				(run) => candidateAccess?.(run) ?? false,
				shutdown.signal,
			);
			if (!shutdown.signal.aborted)
				log.info("canvas.ready", {
					durationMs: Math.round(performance.now() - started),
				});
		} catch (error) {
			if (!shutdown.signal.aborted)
				log.warn("canvas.initialization_failed", {
					reason:
						(error as { code?: unknown } | null)?.code === "EADDRINUSE"
							? "port_in_use"
							: "canvas_unavailable",
				});
			throw new Error("canvas_unavailable");
		} finally {
			opening = undefined;
		}
	}
	return {
		previewOrigin: options.previewOrigin,
		hostOrigin: options.hostOrigin,
		get service() {
			return current().service;
		},
		issue: (body: Parameters<PreviewTokens["issue"]>[0]) =>
			current().issue(body),
		isServiceError: (error: unknown): error is ServiceError =>
			instance?.isServiceError(error) ?? false,
		ready: () => !!instance && !shutdown.signal.aborted,
		setCandidateAccess(access: CandidateAccess) {
			candidateAccess = access;
		},
		async start(signal?: AbortSignal) {
			signal?.throwIfAborted();
			shutdown.signal.throwIfAborted();
			if (instance) return;
			opening ??= Promise.resolve().then(open);
			await waitForShared(
				opening,
				signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
			);
		},
		close() {
			if (closing) return closing;
			closing = Promise.resolve().then(async () => {
				await opening?.catch(() => {});
				const opened = instance;
				instance = undefined;
				await opened?.close();
			});
			shutdown.abort(new Error("canvas_unavailable"));
			return closing;
		},
	};
}

export type CanvasRuntime = ReturnType<typeof createCanvasRuntime>;
