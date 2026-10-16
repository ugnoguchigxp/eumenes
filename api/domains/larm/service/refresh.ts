import type { Capability } from "../contracts";
import { renewProviders, type Control, type ProviderHosts } from "./connect";
import { callerAborted, readJson, record, string, wait } from "./guards";
import type { Lease } from "./profiles";

/** Checks the lease against LARM and renews its claims when they are close to expiring. */
export function createRefresh({
	control,
	profile,
	hostsFor,
	lifetime,
	isCurrent,
	release,
	scheduleRenew,
}: {
	control: Control;
	profile: string;
	hostsFor: () => ProviderHosts;
	/** Aborted when the port closes. */
	lifetime: AbortSignal;
	/** The lease is still the port's shared one. */
	isCurrent: (lease: Lease) => boolean;
	release: (current: Lease) => Promise<void>;
	scheduleRenew: (current: Lease) => void;
}) {
	return async function refresh(
		current: Lease,
		required: Capability[],
		signal?: AbortSignal,
	): Promise<boolean> {
		const scopedControl = (
			path: string,
			init: RequestInit,
			accepted: number[],
		) => control(path, { ...init, signal }, accepted);
		const state = record(
			await readJson(
				await scopedControl(
					`/v1/agent-connections/${current.id}`,
					{ method: "GET" },
					[200],
				),
			),
		);
		if (state.id !== current.id) throw new Error("larm_invalid_connection");
		if (["failed", "expired", "released"].includes(String(state.status)))
			throw new Error(`larm_connection_${state.status}`);
		if (
			state.profile !== profile ||
			state.agentProfile !== current.agentProfile
		)
			throw new Error("larm_invalid_connection");
		if (state.status !== "ready") return false;
		if (!required.every((name) => current.providers.has(name))) return false;
		const expiresAt = Date.parse(string(state.expiresAt));
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
			throw new Error("larm_expired");
		current.expiresAt = Math.min(current.expiresAt, expiresAt);
		if (current.expiresAt > Date.now() + 180_000) return true;
		for (let attempt = 0; current.useCount > 0 && attempt < 120; attempt++)
			await wait(1000, lifetime);
		if (current.useCount > 0) throw new Error("larm_renew_busy");
		try {
			const { providers: next, expiresAt: nextExpiry } = await renewProviders(
				scopedControl,
				current,
				hostsFor(),
			);
			if (current.closing || !isCurrent(current))
				throw new Error("larm_connection_released");
			current.providers = next;
			current.expiresAt = nextExpiry;
			scheduleRenew(current);
			return true;
		} catch (error) {
			// The caller's cancellation says nothing about the shared lease.
			if (callerAborted(error, signal)) throw error;
			await release(current);
			throw error;
		}
	};
}
