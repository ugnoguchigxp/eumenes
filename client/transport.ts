import type { z } from "zod";
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public requestId?: string,
		public detail?: string,
		/** The parsed JSON error body, for contracts that carry data (e.g. field errors). */
		public body?: unknown,
	) {
		super(message);
	}
}
export class ApiConnectionError extends TypeError {
	constructor() {
		super("api_connection_failed");
	}
}
/** How often a client that waits for a starting server asks it again. */
const STARTING_POLL_MS = 1000;
/** One status question is bounded: a server busy in synchronous startup work must not hold the wait past its limit. */
const STARTING_PROBE_MS = 2000;
const pause = (ms: number, signal?: AbortSignal | null) =>
	new Promise<void>((resolve, reject) => {
		signal?.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal!.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
/** The 503 a starting server answers everything but its status with (spec server-listen-first-startup §4). */
async function refusedWhileStarting(response: Response) {
	if (response.status !== 503) return false;
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	return (body as { error?: unknown } | null)?.error === "server_starting";
}

export type TransportOptions = {
	/**
	 * How long a request refused by a starting server waits before it is sent again (the CLI). Without it the 503 is
	 * the caller's: the Web holds its workspace until the status is ready instead.
	 */
	startingWaitMs?: number;
};

export function createTransport(
	baseUrl: string,
	token?: string,
	options: TransportOptions = {},
) {
	const base = new URL(baseUrl);
	/**
	 * Whether to keep waiting: the server says it is starting, refuses with 503 as a starting server does, or gave no
	 * answer in time. Any other answer (ready, or the real API's refusal) ends the wait.
	 */
	async function starting(signal?: AbortSignal | null) {
		const response = await fetch(new URL("/api/status", base), {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
			cache: "no-store",
			signal: AbortSignal.any([
				...(signal ? [signal] : []),
				AbortSignal.timeout(STARTING_PROBE_MS),
			]),
		}).catch(() => null);
		signal?.throwIfAborted();
		if (!response || response.status === 503) {
			await response?.body?.cancel();
			return true;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return false;
		}
		const body: unknown = await response.json().catch(() => null);
		return (body as { phase?: unknown } | null)?.phase === "starting";
	}
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password
	)
		throw new Error("invalid_api_url");
	if (!["127.0.0.1", "localhost"].includes(base.hostname))
		throw new Error("loopback_api_required");
	return {
		identity: base.origin,
		async call(path: string, init: RequestInit = {}) {
			const send = () =>
				fetch(new URL(path, base), {
					...init,
					headers: {
						...(token ? { Authorization: `Bearer ${token}` } : {}),
						...init.headers,
					},
					cache: "no-store",
				}).catch((error: unknown) => {
					if (error instanceof TypeError && !init.signal?.aborted)
						throw new ApiConnectionError();
					throw error;
				});
			let response = await send();
			// A starting server processed nothing, so the same request is sent once more when it is ready.
			if (
				options.startingWaitMs &&
				!(init.body instanceof ReadableStream) &&
				(await refusedWhileStarting(response))
			) {
				const deadline = Date.now() + options.startingWaitMs;
				while (Date.now() < deadline && (await starting(init.signal)))
					await pause(STARTING_POLL_MS, init.signal);
				response = await send();
			}
			if (!response.ok) {
				const body: unknown = await response
					.json()
					.catch(() => ({ error: `HTTP ${response.status}` }));
				const error = (body && typeof body === "object" ? body : {}) as {
					error?: string;
					message?: string;
				};
				throw new ApiError(
					response.status,
					error.error ?? `HTTP ${response.status}`,
					response.headers.get("X-Request-Id") ?? undefined,
					error.message,
					body,
				);
			}
			return response;
		},
	};
}
export type Transport = ReturnType<typeof createTransport>;
export const json = (body: unknown, method = "POST") => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
type QueryValue = string | number | boolean | null | undefined;
/**
 * Appends a query string to `path`: `undefined`/`null` values are skipped, an array repeats its key,
 * and `path` is returned unchanged when nothing remains.
 */
export function withQuery(
	path: string,
	params: URLSearchParams | Record<string, QueryValue | readonly QueryValue[]>,
): string {
	const query = new URLSearchParams();
	const entries =
		params instanceof URLSearchParams
			? [...params].map(([key, value]) => [key, [value]] as const)
			: Object.entries(params);
	for (const [key, value] of entries)
		for (const v of Array.isArray(value) ? value : [value])
			if (v !== undefined && v !== null) query.append(key, String(v));
	const text = query.toString();
	return text ? `${path}?${text}` : path;
}
/** Calls the API and parses the JSON answer with its contract, so a drifted answer fails here. */
export async function callJson<S extends z.ZodType>(
	t: Transport,
	schema: S,
	path: string,
	init?: RequestInit,
): Promise<z.output<S>> {
	return schema.parse(await (await t.call(path, init)).json());
}
