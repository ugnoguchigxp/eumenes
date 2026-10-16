import type { Capability } from "../contracts";
import type { Lease } from "./profiles";
import {
	awaitReady,
	claimProviders,
	createConnection,
	fetchCatalog,
	type Control,
	type ProviderHosts,
} from "./connect";
import { string } from "./guards";

/**
 * Creates a LARM connection and claims its providers: catalog, creation, readiness, claim.
 * A connection that cannot be claimed is released before the error is thrown.
 */
export async function establishLease(
	deps: {
		/** Not bound to the caller's signal: the cleanup DELETE must run after a cancellation. */
		control: Control;
		/** Bound to the caller's signal. */
		scopedControl: Control;
		pause: (ms: number) => Promise<void>;
		hosts: () => ProviderHosts;
		profile: string;
		client: string;
		audience: string;
		idleTimeoutMs: number;
		/** Aborted when the port closes. */
		lifetime: AbortSignal;
	},
	required: Capability[],
	signal: AbortSignal | undefined,
	/** One key per connect(): every attempt to create this connection reuses it. */
	idempotencyKey: string,
): Promise<Lease> {
	const {
		control,
		scopedControl,
		pause,
		hosts,
		profile,
		client,
		audience,
		idleTimeoutMs,
		lifetime,
	} = deps;
	const { catalogRevision, catalogProfile, catalogProviders } =
		await fetchCatalog(scopedControl, profile, required);
	const fullProfile = required.some((name) => name !== "llm");
	const creation = {
		profile,
		client,
		audience,
		fullProfile,
		catalogRevision,
		idempotencyKey,
	};
	let creationResult: Awaited<ReturnType<typeof createConnection>>;
	try {
		creationResult = await createConnection(scopedControl, creation);
	} catch (error) {
		// A timed-out POST may still have created the connection; the same
		// Idempotency-Key makes one retry return it instead of a duplicate.
		if (
			!(error instanceof DOMException && error.name === "TimeoutError") ||
			signal?.aborted ||
			lifetime.aborted
		)
			throw error;
		creationResult = await createConnection(scopedControl, creation);
	}
	const { id, created } = creationResult;
	try {
		const ready = await awaitReady(scopedControl, pause, {
			id,
			created,
			required,
			profile,
			agentProfile: catalogProfile.id,
		});
		const { expiresAt, providers } = await claimProviders(scopedControl, {
			id,
			created: ready,
			required,
			catalogProviders,
			fullProfile,
			hosts: hosts(),
		});
		const current: Lease = {
			id,
			expiresAt,
			providers,
			agentProfile: string(catalogProfile.id),
			useCount: 0,
			closing: false,
			idleAt: Date.now() + idleTimeoutMs,
		};
		return current;
	} catch (error) {
		try {
			await control(
				`/v1/agent-connections/${id}`,
				{ method: "DELETE" },
				[204, 200],
			);
		} catch {
			/* original error is primary */
		}
		throw error;
	}
}
