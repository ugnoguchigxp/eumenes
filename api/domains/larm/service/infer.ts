import { providerRequest } from "./provider-request";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmCallOptions } from "../contracts";
import type { Fetcher, Provider } from "./profiles";
import { decodeSpeechCredit } from "./context";
import { LarmInferenceError, providerError } from "./inference-error";

const log = getLogger("larm");

/** One provider call with the claimed credential: logs, reports the exchange and maps refusals. */
export function createInfer({
	request,
	token,
}: {
	request: Fetcher;
	/** The control credential, withheld from any text that reaches a log. */
	token: string | undefined;
}) {
	return async function infer(
		provider: Provider,
		operation: string,
		init: RequestInit,
		signal: AbortSignal,
		connectionId: string,
		options?: LarmCallOptions,
	): Promise<Response> {
		const endpoint = new URL(
			provider.baseUrl.endsWith("/")
				? provider.baseUrl
				: `${provider.baseUrl}/`,
		);
		const url = provider.endpoint
			? new URL(provider.endpoint)
			: new URL(operation, endpoint);
		if (url.origin !== endpoint.origin)
			throw new Error("larm_endpoint_mismatch");
		const started = Date.now();
		let response: Response;
		try {
			response = await providerRequest(
				request,
				url,
				provider,
				init,
				signal,
				operation,
				options?.attemptMs,
			);
		} catch (error) {
			if (signal.aborted)
				log.info("larm.inference_cancelled", {
					kind: operation,
					reason: "cancelled",
					durationMs: Date.now() - started,
				});
			else
				log.warn(
					"larm.inference_unreachable",
					{
						kind: operation,
						reason: "network_unavailable",
						durationMs: Date.now() - started,
					},
					error,
				);
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				operation,
				started,
			});
			throw error;
		}
		if (!response.ok) {
			const details = await providerError(response, signal, [
				provider.token,
				token ?? "",
			]);
			log.warn("larm.inference_rejected", {
				kind: operation,
				status: response.status,
				reason: `larm_inference_${response.status}`,
				durationMs: Date.now() - started,
			});
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				operation,
				started,
				httpStatus: response.status,
				...details,
			});
			throw new LarmInferenceError(response.status, details.errorCode);
		}
		try {
			const speechCredit =
				operation === "audio/speech"
					? decodeSpeechCredit(response.headers.get("X-VOICEVOX-Credit"))
					: undefined;
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				operation,
				started,
				httpStatus: response.status,
				speechVoice: options?.speechVoice,
				...(speechCredit
					? { speechCredit, speechVoice: options?.speechVoice }
					: {}),
			});
		} catch (error) {
			await response.body?.cancel();
			throw error;
		}
		return response;
	};
}
