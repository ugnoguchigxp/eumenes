import { vectorSpaceKey } from "../../../infrastructure/vector";
import { getLogger } from "../../../infrastructure/logger";
import {
	embeddingVectors,
	type Embed,
	type EmbeddingType,
} from "./embedding-contract";
import { lane } from "./generation-lanes";
import { readJson, record, wait } from "./guards";
import { LarmInferenceError, providerError } from "./inference-error";
import type { createProviderLeases } from "./provider-leases";
import type { Fetcher, Provider } from "./profiles";
import { providerRequest } from "./provider-request";
import { retryAfter } from "./resend";

const runEmbedding = lane(1, 32);
const log = getLogger("larm");
const MAX_TEXTS = 64;
const MAX_BATCH_CHARS = 6400;
const TRANSIENT = [429, 502, 503, 504];

function* batches(texts: string[]) {
	let start = 0;
	let chars = 0;
	for (let i = 0; i < texts.length; i++) {
		const length = texts[i]!.length;
		if (i > start && chars + length > MAX_BATCH_CHARS) {
			yield texts.slice(start, i);
			start = i;
			chars = 0;
		}
		chars += length;
	}
	yield texts.slice(start);
}

export function createEmbedding({
	request,
	withProvider,
	lifetime,
}: {
	request: Fetcher;
	withProvider: ReturnType<typeof createProviderLeases>["withProvider"];
	lifetime: AbortSignal;
}): Embed {
	async function embedBatch(
		batch: string[],
		type: EmbeddingType,
		signal: AbortSignal,
	) {
		const body = JSON.stringify({
			texts: batch,
			type,
			normalize: true,
			priority: "normal",
		});
		return withProvider("embedding", signal, async (provider: Provider) => {
			const space = provider.embeddingSpace;
			if (!provider.endpoint || !space)
				throw new Error("invalid_embedding_claim");
			const url = new URL(provider.endpoint);
			for (let retry = 0; ; retry++) {
				const response = await providerRequest(
					request,
					url,
					provider,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					},
					signal,
					"embed",
				);
				if (response.ok) {
					const vectors = embeddingVectors(
						record(await readJson(response)),
						type,
						batch.length,
					);
					signal.throwIfAborted();
					return { vectors, space };
				}
				const { errorCode } = await providerError(response, signal, [
					provider.token,
				]);
				if (!TRANSIENT.includes(response.status) || retry >= 2) {
					log.warn("larm.embedding_refused", {
						status: response.status,
						reason: errorCode ?? "embedding_refused",
					});
					throw new LarmInferenceError(response.status, errorCode);
				}
				await wait(
					retryAfter(response.headers, 30_000) ?? 200 * 2 ** retry,
					signal,
				);
			}
		});
	}
	return async (texts, type, caller) => {
		if (
			!texts.length ||
			texts.length > MAX_TEXTS ||
			texts.some((text) => typeof text !== "string" || !text.trim()) ||
			(type !== "query" && type !== "passage")
		)
			throw new Error("invalid_embedding_input");
		const vectors: number[][] = [];
		let space: Awaited<ReturnType<Embed>>["space"] | undefined;
		for (const batch of batches(texts)) {
			const signal = AbortSignal.any([
				caller,
				lifetime,
				AbortSignal.timeout(30_000),
			]);
			const result = await runEmbedding(signal, () =>
				embedBatch(batch, type, signal),
			);
			if (space && vectorSpaceKey(space) !== vectorSpaceKey(result.space))
				throw new Error("embedding_space_changed");
			space = result.space;
			vectors.push(...result.vectors);
		}
		return { vectors, space: space! };
	};
}
