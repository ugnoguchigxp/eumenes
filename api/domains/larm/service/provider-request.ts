import { getLogger } from "../../../infrastructure/logger";
import { measureStage } from "../../../infrastructure/performance";
import type { Fetcher, Provider } from "./profiles";

/** Keep credential attachment and the response-header boundary together. */
export function providerRequest(
	request: Fetcher,
	url: URL,
	provider: Provider,
	init: RequestInit,
	signal: AbortSignal,
	operation: string,
	/** The attempt's own time limit; the guard is kept a little longer than it. */
	attemptMs = 0,
) {
	signal.throwIfAborted();
	if (!provider.requested && provider.startedAt !== undefined) {
		provider.requested = true;
		getLogger("larm").info("larm.provider_first_request", {
			kind: provider.name,
			durationMs: Math.round(performance.now() - provider.startedAt),
		});
	}
	return measureStage(
		"larm",
		"response_headers",
		() =>
			request(url, {
				...init,
				headers: { Authorization: `Bearer ${provider.token}`, ...init.headers },
				// The caller owns the deadline; this only bounds a stuck stream.
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(Math.max(300_000, attemptMs + 30_000)),
				]),
				redirect: "error",
			}),
		{ kind: operation },
	);
}
