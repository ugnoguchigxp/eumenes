import type { Lease } from "./profiles";
import { createConnection, fetchCatalog, type Control } from "./connect";
import { string } from "./guards";
import { EMBEDDING_PROFILE, embeddingSpace } from "./embedding-contract";

/** Acquire the scope once. Provider preparation belongs to its individual caller. */
export async function createVoiceLease(
	deps: {
		scopedControl: Control;
		profile: string;
		client: string;
		audience: string;
		idleTimeoutMs: number;
		excludeLlm?: boolean;
		embeddingOnly?: boolean;
		lifetime: AbortSignal;
	},
	idempotencyKey: string,
): Promise<Lease> {
	const {
		scopedControl,
		profile,
		client,
		audience,
		idleTimeoutMs,
		embeddingOnly,
	} = deps;
	async function discover() {
		const catalog = await fetchCatalog(
			scopedControl,
			profile,
			embeddingOnly ? ["embedding"] : ["asr", "tts"],
		);
		if (embeddingOnly) {
			if (catalog.catalogProfile.id !== EMBEDDING_PROFILE)
				throw new Error("invalid_embedding_profile");
			embeddingSpace(
				catalog.catalogProviders.find((p) => p.name === "embedding")!,
			);
		}
		return catalog;
	}
	let catalog = await discover();
	const prepare = () => ({
		profile,
		client,
		audience,
		catalogRevision: catalog.catalogRevision,
		fullProfile: !embeddingOnly,
		...(embeddingOnly
			? { providers: ["embedding"], ttlSeconds: 300 }
			: deps.excludeLlm
				? {
						providers: catalog.catalogProviders
							.filter((p) => p.name !== "llm")
							.map((p) => string(p.name)),
					}
				: {}),
	});
	let request = prepare();
	const startedAt = performance.now();
	async function create(key: string) {
		const send = () =>
			createConnection(scopedControl, { ...request, idempotencyKey: key });
		try {
			return await send();
		} catch (error) {
			if (
				!(error instanceof DOMException && error.name === "TimeoutError") ||
				deps.lifetime.aborted
			)
				throw error;
			return send();
		}
	}
	let result;
	try {
		result = await create(idempotencyKey);
	} catch (error) {
		if (
			!embeddingOnly ||
			!(error instanceof Error) ||
			error.message !== "larm_control_409"
		)
			throw error;
		const latest = await discover();
		if (latest.catalogRevision === catalog.catalogRevision) throw error;
		catalog = latest;
		request = prepare();
		result = await create(crypto.randomUUID());
	}
	const { id, created } = result;
	const { catalogProfile, catalogProviders } = catalog;
	if (["released", "expired"].includes(String(created.status)))
		throw new Error(`larm_connection_${created.status}`);
	if (
		created.profile !== profile ||
		created.agentProfile !== catalogProfile.id ||
		(embeddingOnly && created.catalogRevision !== catalog.catalogRevision) ||
		!Array.isArray(created.providers)
	)
		throw new Error("larm_invalid_connection");
	const expiresAt = Date.parse(string(created.expiresAt));
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
		throw new Error("larm_expired");
	return {
		request,
		id,
		state: created,
		catalogProviders,
		startedAt,
		expiresAt,
		providers: new Map(),
		agentProfile: string(catalogProfile.id),
		useCount: 0,
		closing: false,
		idleAt: Date.now() + idleTimeoutMs,
	};
}
