import type { z } from "zod";
import { getLogger } from "../../../infrastructure/logger";
import type { HttpJsonBindingV1 } from "../../capabilities";

const log = getLogger("tool-runtime.http-json");

/** A backend-registered destination. The model and the browser never name URL or credentials. */
export type HttpJsonConnection = {
	baseUrl: string;
	/** Credentials/headers injected by the backend per request. Never logged or returned. */
	headers(): Record<string, string>;
	/** Hostnames the connection may reach (exact match, no wildcards). */
	allowHosts: string[];
};

export type HttpJsonFailureCode =
	| "invalid_binding"
	| "invalid_input"
	| "connection_unavailable"
	| "insecure_transport"
	| "host_not_allowed"
	| "private_address"
	| "redirect_rejected"
	| "timeout"
	| "network_error"
	| "upstream_client_error"
	| "upstream_server_error"
	| "response_too_large"
	| "invalid_response"
	| "schema_mismatch"
	| "idempotency_key_required";

export type HttpJsonResult =
	| { ok: true; value: unknown; attempts: number }
	| { ok: false; code: HttpJsonFailureCode; attempts: number };

export type HttpJsonRequest = {
	binding: HttpJsonBindingV1;
	/** The model/UI input. Validated with `inputSchema` before anything is sent. */
	input: unknown;
	inputSchema: z.ZodType;
	outputSchema: z.ZodType;
	/** Stable per logical operation (e.g. the event id); sent only when the binding registers a key header. */
	idempotencyKey?: string;
};

const privateHost =
	/^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|\[?::1?\]?|\[?(fc|fd|fe80)[0-9a-f:]*\]?|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2[0-9]|3[01])\..*|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\..*)$/i;

/**
 * Executor of declared `http-json` bindings (spec §5.3). It applies, for every call: registered
 * connection only, https (a loopback http exception exists for fixtures and must be configured),
 * host allowlist, private-address refusal, manual redirects (all refused), timeout, a streamed
 * response size limit, output schema validation and no unconditional retry.
 */
export function createHttpJsonExecutor(config: {
	connections: ReadonlyMap<string, HttpJsonConnection>;
	/** Permit `http://127.0.0.1` for isolated fixtures. Off in production. */
	allowLoopbackHttp?: boolean;
	fetch?: typeof fetch;
}) {
	const doFetch = config.fetch ?? fetch;

	function resolveUrl(
		binding: HttpJsonBindingV1,
		connection: HttpJsonConnection,
		input: Record<string, unknown>,
	): URL | HttpJsonFailureCode {
		let base: URL;
		try {
			base = new URL(connection.baseUrl);
		} catch {
			return "invalid_binding";
		}
		const loopback = config.allowLoopbackHttp && base.hostname === "127.0.0.1";
		if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
			return "insecure_transport";
		if (base.username || base.password) return "invalid_binding";
		if (!connection.allowHosts.includes(base.hostname))
			return "host_not_allowed";
		if (privateHost.test(base.hostname) && !loopback) return "private_address";

		const value = (
			field: HttpJsonBindingV1["pathFields"][string],
		): string | number | boolean | undefined => {
			if ("literal" in field) return field.literal;
			const v = input[field.inputField];
			return typeof v === "string" ||
				typeof v === "number" ||
				typeof v === "boolean"
				? v
				: undefined;
		};
		let path = binding.pathTemplate;
		const placeholders = [...path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(
			(m) => m[1]!,
		);
		if (new Set(placeholders).size !== Object.keys(binding.pathFields).length)
			return "invalid_binding";
		for (const name of placeholders) {
			const field = binding.pathFields[name];
			const v = field ? value(field) : undefined;
			if (v === undefined || String(v) === "" || String(v).startsWith("."))
				return "invalid_input";
			path = path.replaceAll(`{${name}}`, encodeURIComponent(String(v)));
		}
		if (path.includes("{") || path.includes("}")) return "invalid_binding";
		const url = new URL(
			`${base.pathname.replace(/\/+$/, "")}${path}`,
			base.origin,
		);
		if (url.origin !== base.origin) return "host_not_allowed";
		for (const [name, field] of Object.entries(binding.queryFields)) {
			const v = value(field);
			if (v !== undefined) url.searchParams.set(name, String(v));
		}
		return url;
	}

	function body(
		binding: HttpJsonBindingV1,
		input: Record<string, unknown>,
	): string | undefined {
		if (binding.method === "GET") return undefined;
		const out: Record<string, unknown> = {};
		for (const [name, field] of Object.entries(binding.bodyFields)) {
			const v = "literal" in field ? field.literal : input[field.inputField];
			if (v !== undefined) out[name] = v;
		}
		return JSON.stringify(out);
	}

	/** Read at most `limit` bytes; stops pulling from the socket as soon as it is exceeded. */
	async function readLimited(response: Response, limit: number) {
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > limit) {
			await response.body?.cancel().catch(() => {});
			return undefined;
		}
		const reader = response.body?.getReader();
		if (!reader) return new Uint8Array();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
		const all = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			all.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return all;
	}

	async function once(
		binding: HttpJsonBindingV1,
		url: URL,
		connection: HttpJsonConnection,
		payload: string | undefined,
		idempotency: { header: string; key: string } | undefined,
	): Promise<
		| { ok: true; value: unknown }
		| { ok: false; code: HttpJsonFailureCode; retryable: boolean }
	> {
		const headers: Record<string, string> = {
			...connection.headers(),
			accept: "application/json",
		};
		if (payload !== undefined) headers["content-type"] = "application/json";
		if (idempotency) headers[idempotency.header] = idempotency.key;
		const deadline = AbortSignal.timeout(binding.timeoutMs);
		try {
			const response = await doFetch(url, {
				method: binding.method,
				headers,
				body: payload,
				redirect: "manual",
				signal: deadline,
			});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				return { ok: false, code: "redirect_rejected", retryable: false };
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				return response.status >= 500
					? { ok: false, code: "upstream_server_error", retryable: true }
					: { ok: false, code: "upstream_client_error", retryable: false };
			}
			const type = response.headers.get("content-type") ?? "";
			if (!/^application\/(json|[a-z0-9.+-]+\+json)\b/i.test(type)) {
				await response.body?.cancel().catch(() => {});
				return { ok: false, code: "invalid_response", retryable: false };
			}
			const bytes = await readLimited(response, binding.maxResponseBytes);
			if (!bytes)
				return { ok: false, code: "response_too_large", retryable: false };
			let json: unknown;
			try {
				json = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				);
			} catch {
				return { ok: false, code: "invalid_response", retryable: false };
			}
			return { ok: true, value: json };
		} catch {
			// A timeout or reset after a POST was sent leaves the outcome unknown.
			return deadline.aborted
				? { ok: false, code: "timeout", retryable: true }
				: { ok: false, code: "network_error", retryable: true };
		}
	}

	return {
		async execute(request: HttpJsonRequest): Promise<HttpJsonResult> {
			const { binding } = request;
			const refuse = (code: HttpJsonFailureCode, attempts = 0) => {
				log.warn("http_json.refused", { reason: code, method: binding.method });
				return { ok: false, code, attempts } as const;
			};
			const connection = config.connections.get(binding.connectionRef);
			if (!connection) return refuse("connection_unavailable");
			if (binding.method === "GET" && Object.keys(binding.bodyFields).length)
				return refuse("invalid_binding");
			const checked = request.inputSchema.safeParse(request.input);
			if (
				!checked.success ||
				!checked.data ||
				typeof checked.data !== "object" ||
				Array.isArray(checked.data)
			)
				return refuse("invalid_input");
			const input = checked.data as Record<string, unknown>;
			const url = resolveUrl(binding, connection, input);
			if (typeof url === "string") return refuse(url);
			const payload = body(binding, input);
			// Only a POST with a registered idempotency header may be sent more than once.
			const retry = binding.retry;
			if (retry.mode === "idempotency-key" && !request.idempotencyKey)
				return refuse("idempotency_key_required");
			const idempotency =
				binding.method === "POST" && retry.mode === "idempotency-key"
					? { header: retry.header.toLowerCase(), key: request.idempotencyKey! }
					: undefined;
			const attemptsAllowed =
				binding.method === "POST" && retry.mode === "idempotency-key"
					? retry.maxAttempts
					: 1;
			let attempts = 0;
			for (;;) {
				attempts++;
				const result = await once(
					binding,
					url,
					connection,
					payload,
					idempotency,
				);
				if (result.ok) {
					const output = request.outputSchema.safeParse(result.value);
					if (!output.success) return refuse("schema_mismatch", attempts);
					return { ok: true, value: output.data, attempts };
				}
				if (!result.retryable || attempts >= attemptsAllowed)
					return refuse(result.code, attempts);
			}
		},
	};
}
export type HttpJsonExecutor = ReturnType<typeof createHttpJsonExecutor>;
