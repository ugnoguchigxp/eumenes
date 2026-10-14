import type { EmbeddingSpace, LarmTestTarget } from "../contracts/playground";
import { json, list, object, post, str } from "./playground-http";

/**
 * Provider claims and the embedding provider of the configured profile. The provider
 * credential stays inside these closures; callers receive results only.
 */
export function createProviderAccess({
	control,
	connection,
	providerUrl,
	request,
	profile,
	embeddingPath,
}: {
	control: (
		path: string,
		signal: AbortSignal,
		init?: RequestInit,
		accepted?: number[],
	) => Promise<Response>;
	connection: <T>(
		target: LarmTestTarget,
		signal: AbortSignal,
		action: (id: string) => Promise<T>,
	) => Promise<T>;
	providerUrl: (value: string) => URL;
	request: typeof fetch;
	profile: string;
	embeddingPath: string;
}) {
	/** Claim one provider of a ready connection; the credential never leaves this closure. */
	async function claimed(
		target: LarmTestTarget,
		id: string,
		signal: AbortSignal,
	) {
		const claim = await json(
			await control(
				`/v1/agent-connections/${encodeURIComponent(id)}/claim`,
				signal,
				post({
					format:
						target.kind === "embedding"
							? "larm-embedding-provider-v1"
							: "openai-provider-v1",
				}),
			),
		);
		if (
			claim.id !== id ||
			claim.status !== "ready" ||
			Date.parse(str(claim.expiresAt)) < Date.now() + 10_000
		)
			throw new Error("invalid_claim");
		const p = list(claim.providers).find((x) => x.name === target.name);
		if (!p || p.model !== target.model || p.protocol !== target.protocol)
			throw new Error("invalid_claim_binding");
		const fields = object(object(p.configuration).fields),
			credential = object(p.credential);
		if (
			fields.model !== target.model ||
			credential.type !== "bearer" ||
			!(Date.parse(str(credential.expiresAt)) > Date.now() + 10_000)
		)
			throw new Error("invalid_claim_configuration");
		const providerBase = providerUrl(str(fields.baseURL ?? fields.daemonURL));
		if (providerBase.href !== providerUrl(str(p.baseUrl)).href)
			throw new Error("invalid_claim_configuration");
		const endpoint = new URL(
			target.endpoint.replace(/^\/v1\//, ""),
			`${providerBase.href.replace(/\/$/, "")}/`,
		);
		if (
			p.endpoint !== undefined &&
			providerUrl(str(p.endpoint)).href !== endpoint.href
		)
			throw new Error("invalid_claim_endpoint");
		const infer = (init: RequestInit) =>
			request(endpoint, {
				...init,
				redirect: "error",
				signal,
				headers: {
					...init.headers,
					Authorization: `Bearer ${str(credential.token)}`,
				},
			});
		return { infer, fields };
	}
	let embeddingTarget:
		| { target: LarmTestTarget; space: EmbeddingSpace; at: number }
		| undefined;
	/** The embedding provider of the configured profile, with its declared vector space. */
	async function findEmbedding(signal: AbortSignal) {
		if (embeddingTarget && Date.now() - embeddingTarget.at < 600_000)
			return embeddingTarget;
		if (!profile) throw new Error("larm_profile_missing");
		const data = await json(
			await control(
				`/v3/agent-profiles?profile=${encodeURIComponent(profile)}`,
				signal,
			),
		);
		if (
			data.contractVersion !== "agent-connection.v3" ||
			data.requestedProfile !== profile
		)
			throw new Error("invalid_catalog");
		for (const p of list(data.profiles))
			for (const item of list(p.providers ?? [])) {
				if (item.protocol !== "larm.embedding.v1") continue;
				const space = object(item.embeddingSpace),
					model = object(space.model),
					prefixes = object(space.prefixes);
				const dimension = Number(space.dimension);
				if (
					!Number.isInteger(dimension) ||
					dimension < 1 ||
					dimension > 8192 ||
					str(item.endpoint) !== embeddingPath
				)
					throw new Error("invalid_embedding_space");
				embeddingTarget = {
					at: Date.now(),
					target: {
						id: "embedding",
						name: str(item.name),
						model: str(item.model),
						capability: str(item.capability),
						protocol: str(item.protocol),
						kind: "embedding",
						mode: "provider",
						endpoint: embeddingPath,
						profile: str(p.id),
						selector: profile,
						revision: str(data.catalogRevision),
						onDemand: false,
						primary: true,
					},
					space: {
						modelId: str(model.id),
						revision: str(model.revision),
						artifactDigest: str(model.artifactDigest),
						dimension,
						queryPrefix: str(prefixes.query ?? ""),
						passagePrefix: str(prefixes.passage ?? ""),
					},
				};
				return embeddingTarget;
			}
		throw new Error("embedding_unavailable");
	}
	/**
	 * Embed up to 64 texts with the profile's embedding provider. The caller stores the
	 * returned space with each vector and never compares vectors across spaces.
	 */
	async function embed(
		texts: string[],
		type: "query" | "passage",
		signal: AbortSignal,
	): Promise<{ vectors: number[][]; space: EmbeddingSpace }> {
		if (!texts.length || texts.length > 64 || texts.some((t) => !t.trim()))
			throw new Error("invalid_embedding_input");
		const { target, space } = await findEmbedding(signal);
		return connection(target, signal, async (id) => {
			const { infer } = await claimed(target, id, signal);
			const r = await infer(
				post({
					texts,
					type,
					normalize: true,
					// LARM requires a priority: passages are background work, a query is interactive.
					priority: type === "passage" ? "low" : "normal",
				}),
			);
			if (!r.ok) {
				await r.body?.cancel();
				throw new Error(`larm_http_${r.status}`);
			}
			const data = await json(r);
			const vectors = data.embeddings;
			if (
				data.dimension !== space.dimension ||
				!Array.isArray(vectors) ||
				vectors.length !== texts.length ||
				!vectors.every(
					(v) =>
						Array.isArray(v) &&
						v.length === space.dimension &&
						v.every((n) => typeof n === "number" && Number.isFinite(n)),
				)
			)
				throw new Error("invalid_embedding_result");
			return { vectors: vectors as number[][], space };
		});
	}
	return { claimed, embed };
}
