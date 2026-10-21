import { createHash } from "node:crypto";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import {
	computeEnvironment,
	computeRemoteJob,
	computeRequest,
} from "../contracts/compute";

/** Only safe classifications escape this client; upstream text is never an Error message. */
export class ComputeHttpError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly retryAfterMs: number | null = null,
	) {
		super(code);
	}
}
const codes = new Set([
	"invalid_request",
	"limit_exceeded",
	"unauthorized",
	"not_found",
	"request_conflict",
	"artifact_not_ready",
	"job_expired",
	"queue_full",
	"unavailable",
]);
const service = z
	.object({
		capability: z.literal("compute.python.execute"),
		protocol: z.literal("larm.compute.v1"),
		url: z.url().optional(),
		endpoint: z.string().max(8192).optional(),
		description: z.string().max(8000),
	})
	.refine((v) => v.url !== undefined || v.endpoint !== undefined);

export function createComputeClient(options: {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}) {
	const base = new URL(options.baseUrl);
	function checked(value: string) {
		const u = new URL(value);
		if (
			!["http:", "https:"].includes(u.protocol) ||
			u.origin !== base.origin ||
			u.username ||
			u.password ||
			u.search ||
			u.hash
		)
			throw new ComputeHttpError("compute_origin_mismatch", 503);
		return u.href.replace(/\/$/, "");
	}
	function advertisedEndpoint(value: z.infer<typeof service>) {
		if (value.endpoint === undefined) return checked(value.url!);
		if (!value.endpoint.startsWith("/") || value.endpoint.startsWith("//"))
			throw new ComputeHttpError("compute_origin_mismatch", 503);
		const endpoint = new URL(checked(new URL(value.endpoint, base).href));
		if (value.url) {
			const published = new URL(value.url);
			if (
				!["http:", "https:"].includes(published.protocol) ||
				published.username ||
				published.password ||
				published.search ||
				published.hash ||
				published.pathname.replace(/\/$/, "") !==
					endpoint.pathname.replace(/\/$/, "")
			)
				throw new ComputeHttpError("compute_origin_mismatch", 503);
		}
		// Both addresses are advertised by the saved Control; only its relative endpoint is used.
		return checked(endpoint.href);
	}
	checked(base.href);
	const binding = createHash("sha256")
		.update(JSON.stringify([base.origin, options.token]))
		.digest("hex");
	async function bytes(r: Response, limit: number, signal: AbortSignal) {
		return readBounded(r.body, {
			limit,
			signal,
			missing: "compute_empty_response",
			tooLarge: "compute_response_too_large",
		});
	}
	async function request(
		url: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted = [200],
	) {
		const r = await (options.fetch ?? fetch)(checked(url), {
			...init,
			signal,
			redirect: "error",
			headers: { ...init.headers, Authorization: `Bearer ${options.token}` },
		});
		if (!accepted.includes(r.status)) {
			let code = "unavailable";
			try {
				const body = JSON.parse(
					new TextDecoder().decode(await bytes(r, 16384, signal)),
				);
				if (codes.has(body?.error?.code)) code = body.error.code;
			} catch {
				await r.body?.cancel().catch(() => {});
			}
			const retry = r.headers.get("retry-after");
			const delay =
				retry === null
					? null
					: /^\d+$/.test(retry)
						? Number(retry) * 1000
						: Math.max(0, Date.parse(retry) - Date.now());
			throw new ComputeHttpError(
				code,
				r.status,
				delay !== null && Number.isFinite(delay) ? delay : null,
			);
		}
		return r;
	}
	async function json<T>(
		r: Response,
		schema: z.ZodType<T>,
		signal: AbortSignal,
		limit = 2 * 1024 * 1024,
	) {
		try {
			return schema.parse(
				JSON.parse(new TextDecoder().decode(await bytes(r, limit, signal))),
			);
		} catch {
			throw new ComputeHttpError("compute_invalid_response", 502);
		}
	}
	const path = (url: string, id: string) =>
		`${checked(url)}/jobs/${z.uuid().parse(id)}`;
	async function job(
		url: string,
		id: string,
		signal: AbortSignal,
		cancel = false,
	) {
		const value = await json(
			await request(
				`${path(url, id)}${cancel ? "/cancel" : ""}`,
				signal,
				cancel ? { method: "POST" } : {},
				cancel ? [200, 202] : [200],
			),
			computeRemoteJob,
			signal,
		);
		if (value.jobId !== id)
			throw new ComputeHttpError("compute_identity_mismatch", 502);
		return value;
	}
	return {
		binding,
		async discover(signal: AbortSignal) {
			const catalog = await json(
				await request(new URL("/v3/agent-profiles", base).href, signal),
				z.object({
					services: z.array(z.unknown()).default([]),
					profiles: z
						.array(z.object({ services: z.array(z.unknown()).default([]) }))
						.default([]),
				}),
				signal,
			);
			const candidates = [
				...catalog.services,
				...catalog.profiles.flatMap((p) => p.services),
			];
			for (const candidate of candidates) {
				const parsed = service.safeParse(candidate);
				if (!parsed.success) continue;
				const url = advertisedEndpoint(parsed.data);
				const environment = await json(
					await request(`${url}/environment`, signal),
					computeEnvironment,
					signal,
					131072,
				);
				return { url, description: parsed.data.description, environment };
			}
			throw new ComputeHttpError("compute_service_unavailable", 503);
		},
		async submit(
			url: string,
			body: z.infer<typeof computeRequest>,
			key: string,
			signal: AbortSignal,
		) {
			if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
				throw new ComputeHttpError("invalid_request", 400);
			const r = await request(
				`${checked(url)}/jobs`,
				signal,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": key,
					},
					body: JSON.stringify(computeRequest.parse(body)),
				},
				[202],
			);
			return (await json(r, z.strictObject({ jobId: z.uuid() }), signal, 1024))
				.jobId;
		},
		get: (url: string, id: string, signal: AbortSignal) => job(url, id, signal),
		cancel: (url: string, id: string, signal: AbortSignal) =>
			job(url, id, signal, true),
		async delete(url: string, id: string, signal: AbortSignal) {
			const r = await request(
				path(url, id),
				signal,
				{ method: "DELETE" },
				[200, 202, 204],
			);
			if (r.status === 204) {
				await r.body?.cancel();
				return null;
			}
			const value = await json(r, computeRemoteJob, signal);
			if (value.jobId !== id)
				throw new ComputeHttpError("compute_identity_mismatch", 502);
			return value;
		},
		async artifact(
			url: string,
			id: string,
			artifact: { id: string; mime: string; bytes: number },
			signal: AbortSignal,
		) {
			const r = await request(
				`${path(url, id)}/artifacts/${z.uuid().parse(artifact.id)}`,
				signal,
			);
			const mime = r.headers.get("content-type")?.split(";")[0]?.trim();
			if (mime !== artifact.mime || artifact.bytes > 5 * 1024 * 1024) {
				await r.body?.cancel();
				throw new ComputeHttpError("compute_invalid_artifact", 502);
			}
			const content = await bytes(
				r,
				Math.min(artifact.bytes, 5 * 1024 * 1024),
				signal,
			);
			if (
				content.byteLength !== artifact.bytes ||
				(mime === "image/png" &&
					![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => content[i] === b))
			)
				throw new ComputeHttpError("compute_invalid_artifact", 502);
			return content;
		},
	};
}
