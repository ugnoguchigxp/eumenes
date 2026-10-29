import type { Lease, ProviderName } from "./profiles";
import { createConnection, fetchCatalog, type Control } from "./connect";
import { string } from "./guards";

/** Acquire the scope once. Provider preparation belongs to its individual caller. */
export async function createVoiceLease(
	deps: {
		scopedControl: Control;
		profile: string;
		client: string;
		audience: string;
		idleTimeoutMs: number;
		fullProfile: boolean;
		/** The Providers a partial connection selects. */
		providers?: string[];
		lifetime: AbortSignal;
	},
	required: ProviderName[],
	idempotencyKey: string,
): Promise<Lease> {
	const {
		scopedControl,
		profile,
		client,
		audience,
		idleTimeoutMs,
		fullProfile,
		providers,
	} = deps;
	const { catalogRevision, catalogProfile, catalogProviders } =
		await fetchCatalog(scopedControl, profile, required);
	const request = {
		profile,
		client,
		audience,
		fullProfile,
		...(providers ? { providers } : {}),
		catalogRevision,
	};
	const startedAt = performance.now();
	const create = () =>
		createConnection(scopedControl, { ...request, idempotencyKey });
	let result;
	try {
		result = await create();
	} catch (error) {
		if (
			!(error instanceof DOMException && error.name === "TimeoutError") ||
			deps.lifetime.aborted
		)
			throw error;
		result = await create();
	}
	const { id, created } = result;
	if (["released", "expired"].includes(String(created.status)))
		throw new Error(`larm_connection_${created.status}`);
	if (
		created.profile !== profile ||
		created.agentProfile !== catalogProfile.id ||
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
