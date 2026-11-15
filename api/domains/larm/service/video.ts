import { readVideoOptions } from "./video-options";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	videoJob,
	videoList,
	videoMetadata,
	type VideoArtifact,
	type VideoJob,
} from "../contracts/video";
import { readBounded } from "../../../infrastructure/bounded-read";
import { createControl } from "./control";
import { gzipFetch } from "./gzip-fetch";
import { localUrl } from "./playground-http";
import { onDemandRefusal, retryAfter } from "./resend";

export class VideoHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly retryAfterMs: number | null = null,
	) {
		super(code);
	}
}

const invalidResponse = () => new VideoHttpError(502, "invalid_video_response");
const library = "/v1/videos";
const generations = library + "/generations";
const serviceSchema = z.object({
	capability: z.literal("media.video.generate"),
	protocol: z.literal("larm.video-generation.v1"),
	model: z.string().min(1),
	description: z.string().min(1),
	url: z.string().optional(),
	endpoint: z.string().optional(),
});
const catalogSchema = z.object({
	contractVersion: z.literal("agent-connection.v3"),
	services: z.array(z.unknown()),
});
const errorSchema = z.object({
	error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/) }),
});

export function createVideoClient(options: {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}) {
	const base = localUrl(options.baseUrl, [new URL(options.baseUrl).hostname]);
	const control = createControl({
		base,
		token: options.token,
		request: gzipFetch(options.fetch ?? fetch, false),
		lifetime: new AbortController().signal,
	});
	function publicPath(value: string, expected: string) {
		const url = new URL(value, base);
		if (
			url.origin !== base.origin ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== expected
		)
			throw invalidResponse();
		return url.pathname;
	}
	async function decode<T>(
		response: Response,
		schema: z.ZodType<T>,
		signal: AbortSignal,
		limit = 2_000_000,
	) {
		try {
			const bytes = await readBounded(response.body, {
				limit,
				signal,
				missing: "invalid_video_response",
				tooLarge: "invalid_video_response",
			});
			return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			throw invalidResponse();
		}
	}
	async function call(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted = [200],
	) {
		const r = await control(path, { ...init, signal }, null);
		if (accepted.includes(r.status)) return r;
		const data = await decode(r, errorSchema, signal, 16_384).catch(() => null);
		throw (
			onDemandRefusal(r.status, data) ??
			new VideoHttpError(
				r.status,
				r.status === 401
					? "unauthorized"
					: (data?.error.code ?? `larm_http_${r.status}`),
				retryAfter(r.headers, Infinity),
			)
		);
	}
	function saved(value: VideoArtifact) {
		const path = `${generations}/${value.id}`;
		return {
			...value,
			contentUrl: publicPath(value.contentUrl, path + "/content"),
			metadataUrl: publicPath(value.metadataUrl, path + "/metadata"),
		};
	}
	function checkedJob(job: VideoJob, id = job.jobId): VideoJob {
		if (job.jobId !== id) throw invalidResponse();
		const path = `${generations}/${id}`;
		const { result, ...state } = job;
		if (job.status === "completed" && (!result || result.id !== id))
			throw invalidResponse();
		return {
			...state,
			statusUrl: publicPath(job.statusUrl, path),
			eventsUrl: publicPath(job.eventsUrl, path + "/events"),
			...(job.status === "completed" && result
				? { result: saved(result) }
				: {}),
		};
	}
	async function jobResponse(r: Response, signal: AbortSignal, id?: string) {
		return {
			job: checkedJob(await decode(r, videoJob, signal), id),
			retryAfterMs: retryAfter(r.headers, Infinity),
		};
	}
	return {
		binding: createHash("sha256")
			.update(JSON.stringify([base.href, options.token]))
			.digest("hex"),
		async discover(signal: AbortSignal) {
			const catalog = await decode(
				await call("/v3/agent-profiles", signal),
				catalogSchema,
				signal,
			);
			for (const value of catalog.services) {
				const service = serviceSchema.safeParse(value);
				if (!service.success) continue;
				const { url, endpoint, model, description } = service.data;
				return {
					path: publicPath(url ?? endpoint ?? "", generations),
					model,
					description,
				};
			}
			throw new VideoHttpError(503, "video_unavailable");
		},
		async options(path: string, signal: AbortSignal) {
			const response = await call("/openapi.json", signal);
			const document = await decode(response, z.unknown(), signal);
			try {
				return readVideoOptions(document, publicPath(path, generations));
			} catch {
				throw invalidResponse();
			}
		},
		async submit(path: string, body: string, key: string, signal: AbortSignal) {
			return jobResponse(
				await call(
					publicPath(path, generations),
					signal,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Idempotency-Key": key,
						},
						body,
					},
					[202],
				),
				signal,
			);
		},
		async status(
			job: Pick<VideoJob, "statusUrl" | "jobId">,
			signal: AbortSignal,
			cancel = false,
		) {
			const path = publicPath(job.statusUrl, `${generations}/${job.jobId}`);
			return jobResponse(
				await call(path, signal, cancel ? { method: "DELETE" } : {}),
				signal,
				job.jobId,
			);
		},
		async list(signal: AbortSignal) {
			const values = await decode(
				await call(library, signal),
				videoList,
				signal,
			);
			return values.videos.map(saved);
		},
		async metadata(item: VideoArtifact, signal: AbortSignal) {
			const value = await decode(
				await call(saved(item).metadataUrl, signal),
				videoMetadata,
				signal,
			);
			if (value.id !== item.id) throw invalidResponse();
			return { ...saved(value), request: value.request };
		},
		async content(
			item: VideoArtifact,
			range: string | undefined,
			signal: AbortSignal,
		) {
			const r = await call(
				saved(item).contentUrl,
				signal,
				{ headers: range ? { Range: range } : {} },
				[200, 206, 416],
			);
			const headers = new Headers({ "Cache-Control": "no-store" });
			if (r.status === 416) {
				await r.body?.cancel();
				const range = r.headers.get("Content-Range");
				if (range) headers.set("Content-Range", range);
				return new Response(null, { status: 416, headers });
			}
			if (
				r.headers.get("Content-Type")?.split(";")[0]?.trim() !== "video/mp4"
			) {
				await r.body?.cancel();
				throw invalidResponse();
			}
			// Stream without forwarding Content-Length, as for the authenticated audio proxy.
			for (const key of ["Content-Type", "Content-Range", "Accept-Ranges"]) {
				const value = r.headers.get(key);
				if (value) headers.set(key, value);
			}
			return new Response(r.body, { status: r.status, headers });
		},
		async remove(id: string, signal: AbortSignal) {
			await call(`${library}/${id}`, signal, { method: "DELETE" }, [204]);
		},
	};
}
export type VideoClient = ReturnType<typeof createVideoClient>;
