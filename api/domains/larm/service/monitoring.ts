import type { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { isNetworkError } from "../../../infrastructure/error-code";
import { gzipFetch } from "./gzip-fetch";
import {
	MONITORING_VERSION,
	monitoringSnapshotSchema,
	monitoringEventsSchema,
	monitoringErrorSchema,
} from "../contracts/monitoring-v1";
import type { Fetcher } from "./profiles";
import { createControl } from "./control";
import { untilAborted } from "./guards";

export type MonitoringRead<T> = {
	status:
		| "ok"
		| "unreachable"
		| "timeout"
		| "unauthorized"
		| "forbidden"
		| "not_found"
		| "unsupported_contract"
		| "rate_limited"
		| "unavailable"
		| "invalid_response"
		| "http_error";
	data?: T;
	httpStatus?: number;
	errorCode?: z.infer<typeof monitoringErrorSchema>["error"]["code"];
	reasonCode?: string;
	bootEpoch?: string;
	retryAfterMs?: number;
	bytes?: number;
};
const statuses: Record<number, MonitoringRead<never>["status"]> = {
	401: "unauthorized",
	403: "forbidden",
	404: "not_found",
	406: "unsupported_contract",
	429: "rate_limited",
	503: "unavailable",
};
/** The ordinary provider JSON reader allows 2MB; monitoring pages use the same bound. */
export const MONITORING_BODY_LIMIT = 2_000_000;

/** Passive Control reads only. No leases, claims, probes, retry or provider operations. */
export function createMonitoringClient(config: {
	baseUrl: string;
	token: string;
	lifetime: AbortSignal;
	fetch?: Fetcher;
	now?: () => number;
}) {
	const control = createControl({
		base: new URL(config.baseUrl),
		token: config.token,
		lifetime: config.lifetime,
		request: gzipFetch(config.fetch ?? fetch),
	});
	const now = config.now ?? Date.now;
	async function read<S extends z.ZodType>(
		path: string,
		schema: S,
		signal?: AbortSignal,
	): Promise<MonitoringRead<z.output<S>>> {
		const scoped = AbortSignal.any([
			config.lifetime,
			AbortSignal.timeout(5000),
			...(signal ? [signal] : []),
		]);
		let status: number | undefined;
		let retryAfterMs: number | undefined;
		try {
			const response = await untilAborted(
				control(path, { method: "GET", signal: scoped }, null),
				scoped,
			);
			status = response.status;
			const retry = response.headers.get("Retry-After");
			const ms =
				retry === null
					? undefined
					: /^\d+$/.test(retry)
						? Number(retry) * 1000
						: Date.parse(retry) - now();
			if (ms !== undefined && Number.isFinite(ms))
				retryAfterMs = Math.max(0, ms);
			const raw = await readBounded(response.body, {
				limit: MONITORING_BODY_LIMIT,
				tooLarge: "monitoring_response_too_large",
				missing: "monitoring_response_missing",
				signal: scoped,
			});
			scoped.throwIfAborted();
			const data: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (status === 200) {
				const parsed = schema.safeParse(data);
				return parsed.success
					? {
							status: "ok",
							httpStatus: status,
							data: parsed.data,
							bytes: raw.byteLength,
						}
					: { status: "invalid_response", httpStatus: status };
			}
			const error = monitoringErrorSchema.safeParse(data);
			return {
				status: statuses[status] ?? "http_error",
				httpStatus: status,
				...(error.success ? { errorCode: error.data.error.code } : {}),
				...(error.success ? { bootEpoch: error.data.error.bootEpoch } : {}),
				...(error.success && error.data.error.reasonCode
					? { reasonCode: error.data.error.reasonCode }
					: {}),
				...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
			};
		} catch (error) {
			config.lifetime.throwIfAborted();
			signal?.throwIfAborted();
			if (status !== undefined)
				return {
					status:
						status === 200
							? "invalid_response"
							: (statuses[status] ?? "http_error"),
					httpStatus: status,
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			if (
				(error instanceof DOMException && error.name === "TimeoutError") ||
				scoped.aborted
			)
				return { status: "timeout" };
			return {
				status: isNetworkError(error) ? "unreachable" : "invalid_response",
			};
		}
	}
	return {
		snapshot: (signal?: AbortSignal) =>
			read(
				`/v1/monitoring/snapshot?contractVersion=${MONITORING_VERSION}`,
				monitoringSnapshotSchema,
				signal,
			),
		events: (cursor?: string | null, signal?: AbortSignal) => {
			const query = new URLSearchParams({
				contractVersion: MONITORING_VERSION,
				limit: "500",
			});
			if (cursor) query.set("cursor", cursor);
			return read(
				`/v1/monitoring/events?${query}`,
				monitoringEventsSchema,
				signal,
			);
		},
	};
}
