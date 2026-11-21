import { z } from "zod";
import {
	dot,
	vectorSpaceKey,
	type VectorSpaceShape,
} from "../../../infrastructure/vector";
import { providerEndpoint, readJson, record, string } from "./guards";
import { LarmInferenceError, providerError } from "./inference-error";
import type { Control, ProviderHosts } from "./connect";
import type { Provider } from "./profiles";
import policy from "./embedding-policy.json";

export const EMBEDDING_SELECTOR = "embeddingCanary";
export const EMBEDDING_PROFILE = "contextstill-embedding";
export const EMBEDDING_PROTOCOL = "larm.embedding.v1";
export const EMBEDDING_FORMAT = "larm-embedding-provider-v1";

const spaceSchema = z.looseObject({
	contractVersion: z.string().min(1),
	workload: z.string().min(1),
	model: z.looseObject({
		id: z.literal(`${policy.namespace}/${policy.model}`),
		revision: z.literal(policy.revision),
		artifactDigest: z.string().min(1),
	}),
	dimension: z.literal(512),
	inputTypes: z
		.array(z.enum(["query", "passage"]))
		.length(2)
		.refine((types) => new Set(types).size === 2),
	prefixes: z.looseObject({
		query: z.literal("検索クエリ: "),
		passage: z.literal("検索文書: "),
	}),
	normalization: z.literal("l2"),
	tokenization: z.looseObject({
		kind: z.literal("sentencepiece-unigram"),
		tokenizerDigest: z.string().min(1),
		maxTokens: z.literal(8192),
		truncation: z.literal("end"),
		pooling: z.literal("mean"),
	}),
});

export function embeddingSpace(
	provider: Record<string, unknown>,
): VectorSpaceShape {
	if (
		provider.name !== "embedding" ||
		provider.protocol !== EMBEDDING_PROTOCOL ||
		provider.model !== policy.model
	)
		throw new Error("invalid_embedding_provider");
	const parsed = spaceSchema.safeParse(provider.embeddingSpace);
	if (!parsed.success) throw new Error("invalid_embedding_space");
	const space = parsed.data;
	return {
		modelId: space.model.id,
		revision: space.model.revision,
		artifactDigest: space.model.artifactDigest,
		dimension: space.dimension,
		embeddingSpace: space,
	};
}

export async function claimEmbedding(
	control: Control,
	id: string,
	declared: Record<string, unknown>,
	hosts: ProviderHosts,
	signal: AbortSignal,
): Promise<{ provider: Provider; expiresAt: number }> {
	const space = embeddingSpace(declared);
	const response = await control(
		`/v1/agent-connections/${id}/claim`,
		{
			method: "POST",
			signal,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				format: EMBEDDING_FORMAT,
				providers: ["embedding"],
			}),
		},
		[200, 401, 409],
	);
	if (!response.ok) {
		const { errorCode } = await providerError(response, signal, []);
		throw new LarmInferenceError(response.status, errorCode);
	}
	const body = record(await readJson(response));
	const info = Array.isArray(body.providers)
		? body.providers.map(record).find((item) => item.name === "embedding")
		: undefined;
	if (
		body.id !== id ||
		body.status !== "ready" ||
		!info ||
		info.protocol !== declared.protocol ||
		info.model !== declared.model ||
		(info.embeddingSpace !== undefined &&
			vectorSpaceKey(embeddingSpace(info)) !== vectorSpaceKey(space))
	)
		throw new Error("invalid_embedding_claim");
	const credential = record(info.credential);
	const expiresAt = Date.parse(string(body.expiresAt));
	const credentialExpiry = Date.parse(string(credential.expiresAt));
	if (
		credential.type !== "bearer" ||
		!(Math.min(expiresAt, credentialExpiry) > Date.now() + 10_000)
	)
		throw new Error("larm_credential_expired");
	// The embedding claim carries the complete public route, including its gateway prefix.
	const endpoint = providerEndpoint(
		new URL(string(info.endpoint), hosts.base).href,
		hosts.base,
		hosts.extra,
	);
	if (endpoint.origin !== hosts.base.origin)
		throw new Error("invalid_embedding_endpoint");
	return {
		expiresAt,
		provider: {
			name: "embedding",
			endpoint: endpoint.href,
			baseUrl: endpoint.origin,
			model: string(info.model),
			protocol: EMBEDDING_PROTOCOL,
			token: string(credential.token),
			expiresAt: credentialExpiry,
			embeddingSpace: space,
		},
	};
}

export type EmbeddingType = "query" | "passage";
export type Embed = (
	texts: string[],
	type: EmbeddingType,
	signal: AbortSignal,
) => Promise<{ vectors: number[][]; space: VectorSpaceShape }>;

export function embeddingVectors(
	data: Record<string, unknown>,
	type: EmbeddingType,
	count: number,
): number[][] {
	const vectors = data.embeddings;
	if (
		data.dimension !== 512 ||
		data.count !== count ||
		data.type !== type ||
		!Array.isArray(vectors) ||
		vectors.length !== count ||
		!vectors.every(
			(v) =>
				Array.isArray(v) &&
				v.length === 512 &&
				v.every(Number.isFinite) &&
				Math.abs(Math.sqrt(dot(v, v)) - 1) <= 0.001,
		)
	)
		throw new Error("invalid_embedding_result");
	return vectors;
}
