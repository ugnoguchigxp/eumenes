import { weatherPlace } from "../../domains/capabilities";
import type { DomainAdapter, InstantResult } from "../../domains/tool-runtime";
import { getLogger } from "../../infrastructure/logger";
import { readBounded } from "../../infrastructure/bounded-read";
import { parseAreas, type WeatherAreas } from "./weather-areas";
import { forecastSentence } from "./weather-forecast";

export const WEATHER_ADAPTER_REF = "adapter:weather@1";
const FORECAST = "weather.forecast";
const INPUT_SCHEMA = "builtin:weatherPlace";

const log = getLogger("weather");

/**
 * The forecast service and the forecast agency's list of areas (whose area ids are the service's). Only these
 * two documents are read; their addresses are fixed here.
 */
const SERVICE = "https://weather.tsukumijima.net";
const AREAS_URL = "https://www.jma.go.jp/bosai/common/const/area.json";
const forecastUrl = (id: string) => `${SERVICE}/api/forecast/city/${id}`;

const AREAS_LIMIT_BYTES = 1024 * 1024;
const FORECAST_LIMIT_BYTES = 512 * 1024;
const AREAS_TIMEOUT_MS = 10_000;
const FORECAST_TIMEOUT_MS = 8_000;
/** The list changes about never; it is read again once a day, and a failed read is retried after a minute. */
const AREAS_TTL_MS = 24 * 3_600_000;
const AREAS_RETRY_MS = 60_000;

/** What the adapter offers a bundle check without a running service. */
export const describeWeatherAdapter = () => ({
	owner: "weather",
	operations: new Map([
		[FORECAST, { inputSchemaRef: INPUT_SCHEMA, effect: "read" as const }],
	]),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:weather@1",
	instant: true,
});

class FetchFailure extends Error {}

/**
 * One document of the forecast service: no redirect is followed, the wait and the size are bounded, and
 * anything but a plain 200 is a failure of the service, not of the caller.
 */
async function load(
	fetcher: typeof fetch,
	url: string,
	options: { timeoutMs: number; limit: number; signal?: AbortSignal },
) {
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	try {
		const response = await fetcher(url, {
			redirect: "manual",
			signal,
			headers: { "user-agent": "eumenes-weather" },
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new FetchFailure("weather_http_status");
		}
		const bytes = await readBounded(response.body, {
			limit: options.limit,
			tooLarge: "weather_too_large",
			missing: "weather_empty",
			signal,
		});
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		// The caller's own abort (a cancelled run) is not a failure of the service.
		if (options.signal?.aborted) throw options.signal.reason;
		if (error instanceof FetchFailure) throw error;
		if (
			error instanceof Error &&
			(error.message === "weather_too_large" ||
				error.message === "weather_empty")
		)
			throw new FetchFailure(error.message);
		throw new FetchFailure(
			signal.aborted ? "weather_timeout" : "weather_unreachable",
		);
	}
}

/**
 * The weather toolchain's adapter (spec weather-instant-toolchain-design 2026-10-18 §7). It keeps the list of
 * areas in memory, finds the forecast area of the place the call names, and answers with the fixed sentence
 * made from the forecast service's answer. Without the list it is unavailable, so the toolchain is not offered;
 * a place the list does not know is a failure, which hands the request to web search.
 */
export function createWeatherAdapter(
	options: { fetch?: typeof fetch; now?: () => number } = {},
): DomainAdapter & { maintain(): Promise<void> } {
	const fetcher = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let areas: WeatherAreas | undefined;
	let loadedAt = Number.NEGATIVE_INFINITY;
	let triedAt = Number.NEGATIVE_INFINITY;
	let loading: Promise<void> | undefined;

	function refresh() {
		loading ??= (async () => {
			triedAt = now();
			try {
				areas = parseAreas(
					await load(fetcher, AREAS_URL, {
						timeoutMs: AREAS_TIMEOUT_MS,
						limit: AREAS_LIMIT_BYTES,
					}),
				);
				loadedAt = now();
				log.info("weather.areas_loaded", { count: areas.size });
			} catch (error) {
				// The earlier list, if any, keeps standing.
				log.warn(
					"weather.areas_failed",
					{
						reason:
							error instanceof Error && /^[a-z_]+$/.test(error.message)
								? error.message
								: "weather_areas_failed",
					},
					error,
				);
			} finally {
				loading = undefined;
			}
		})();
		return loading;
	}
	/** Read the list when it is missing or a day old (a failed read waits a minute before the next). */
	async function maintain() {
		const at = now();
		if (
			!loading &&
			at - loadedAt >= AREAS_TTL_MS &&
			at - triedAt >= AREAS_RETRY_MS
		)
			await refresh();
	}

	const unsupported = () => {
		throw new Error("unsupported_operation");
	};
	return {
		ref: WEATHER_ADAPTER_REF,
		describe: describeWeatherAdapter,
		maintain,
		availableInTransaction: () => !!areas,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: unsupported,
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
		instant: {
			async run(operationName, input, signal): Promise<InstantResult> {
				if (operationName !== FORECAST)
					return { ok: false, code: "unsupported_operation" };
				const parsed = weatherPlace.safeParse(input);
				if (!parsed.success || !areas)
					return { ok: false, code: "invalid_input" };
				const place = areas.resolve(parsed.data.place, parsed.data.prefecture);
				if (!place) {
					log.info("weather.place_unknown", {
						reason: "weather_place_unknown",
					});
					return { ok: false, code: "weather_place_unknown" };
				}
				const started = now();
				try {
					const text = await load(fetcher, forecastUrl(place.id), {
						timeoutMs: FORECAST_TIMEOUT_MS,
						limit: FORECAST_LIMIT_BYTES,
						signal,
					});
					let body: unknown;
					try {
						body = JSON.parse(text);
					} catch {
						throw new FetchFailure("weather_forecast_invalid");
					}
					return {
						ok: true,
						answer: forecastSentence(body, parsed.data.day, place),
					};
				} catch (error) {
					signal.throwIfAborted();
					const code =
						error instanceof Error && /^[a-z_]+$/.test(error.message)
							? error.message
							: "weather_failed";
					log.warn("weather.forecast_failed", {
						reason: code,
						durationMs: now() - started,
					});
					return { ok: false, code };
				}
			},
		},
	};
}
