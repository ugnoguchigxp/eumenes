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

/** Claims of a ready connection LARM refuses (409) before the error is final, one second apart. */
const CLAIM_ATTEMPTS = 60;

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
		const readyInput = {
			id,
			required,
			profile,
			agentProfile: catalogProfile.id,
		};
		let ready = await awaitReady(scopedControl, pause, {
			...readyInput,
			created,
		});
		let claimed: Awaited<ReturnType<typeof claimProviders>>;
		for (let attempt = 1; ; attempt++) {
			try {
				claimed = await claimProviders(scopedControl, {
					id,
					created: ready,
					required,
					catalogProviders,
					fullProfile,
					hosts: hosts(),
				});
				break;
			} catch (error) {
				// Ready but not yet claimable (a profile switch): LARM refuses the claim; wait and look again.
				if (
					!(error instanceof Error && error.message === "larm_control_409") ||
					attempt >= CLAIM_ATTEMPTS
				)
					throw error;
				await pause(1000);
				ready = await awaitReady(scopedControl, pause, {
					...readyInput,
					created: ready,
				});
			}
		}
		const { expiresAt, providers } = claimed;
		signal?.throwIfAborted();
		lifetime.throwIfAborted();
		const current: Lease = {
			request: { profile, client, audience, fullProfile, catalogRevision },
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
