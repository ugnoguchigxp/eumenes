import {
	isNetworkError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
import type { Capability, LarmStatus } from "../contracts";
import type { Lease } from "./profiles";
import { type Control, type ProviderHosts } from "./connect";
import { establishLease } from "./establish";
import { drainLease } from "./drain-lease";
import { leaseStatus, createStatusChanges } from "./lease-status";
import { createRefresh } from "./refresh";
import {
	createProfileRetention,
	repeatProfile,
	scheduleCredentialRenewal,
} from "./profile-retention";
import { createWithProvider } from "./with-provider";
import { callerAborted, untilAborted, wait } from "./guards";

const log = getLogger("larm");

function preparationSignal(lifetime: AbortSignal, caller?: AbortSignal) {
	return AbortSignal.any([
		lifetime,
		AbortSignal.timeout(60_000),
		...(caller ? [caller] : []),
	]);
}

function stopUsing(current: Lease) {
	current.closing = true;
	clearTimeout(current.renewTimer);
	clearTimeout(current.idleTimer);
}

/** One terminal DELETE, even when recovery and the final borrower both clean up. */
async function releaseConnection(current: Lease, control: Control) {
	if (current.release) return current.release;
	current.release = control(
		`/v1/agent-connections/${encodeURIComponent(current.id)}`,
		{ method: "DELETE" },
		[204, 200, 404, 410],
	)
		.then((response) => {
			// The status confirms deletion; body cleanup must not hold up reconnection.
			void response.body?.cancel().catch(() => {});
			try {
				log.info("larm.connection_released", {
					connectionId: current.id,
					status: response.status,
				});
			} catch {
				/* Observation does not invalidate a confirmed release. */
			}
		})
		.catch((error: unknown) => {
			current.release = undefined;
			throw error;
		});
	return current.release;
}

/**
 * The one shared connection of a port: creation, renewal, release and the status it reports.
 * Work borrows a provider of the lease through `withProvider`, which counts the use so the
 * lease is neither renewed nor released underneath it.
 */
export function createLeaseManager({
	base,
	token,
	profile,
	audience,
	client,
	idleTimeoutMs,
	keepAlive = false,
	hostsFor,
	control,
	lifetime,
}: {
	base: URL | undefined;
	token: string | undefined;
	profile: string;
	audience: string;
	client: string;
	idleTimeoutMs: number;
	/** The connection is held while the port is open, as LARM's input cache lives on it (not only while a screen shows). */
	keepAlive?: boolean;
	hostsFor: () => ProviderHosts;
	control: Control;
	/** Aborted when the port closes. */
	lifetime: AbortController;
}) {
	let lease: Lease | undefined;
	let connecting: Promise<Lease> | undefined;
	let lastError: string | undefined;
	let closed = false;
	let retained = false;
	let checkingProfile = false;
	const status = (): LarmStatus =>
		leaseStatus({
			configured: !!token && !!base && !!profile,
			baseConfigured: !!base,
			profileSaved: !!profile,
			connecting: !!connecting && !(checkingProfile && lease && !lease.closing),
			lastError,
			lease,
		});
	const changes = createStatusChanges(status);
	const notify = changes.notify;
	async function release(current: Lease, force = false) {
		stopUsing(current);
		if (current.useCount > 0 && !force) return;
		if (lease === current) lease = undefined;
		notify();
		if (current.kept) return;
		try {
			await releaseConnection(current, control);
		} catch {
			if (!lease) {
				lastError = "larm_release_unconfirmed";
				notify();
			}
		}
	}
	function discard(current: Lease, error?: string) {
		stopUsing(current);
		if (lease === current) {
			lease = undefined;
			lastError = error;
			notify();
		}
	}
	function scheduleIdle(current: Lease) {
		clearTimeout(current.idleTimer);
		if (retained) return;
		current.idleTimer = setTimeout(
			() => {
				if (lease === current && !current.useCount) discard(current);
			},
			Math.max(0, current.idleAt - Date.now()),
		);
		current.idleTimer.unref?.();
	}
	function scheduleRenew(current: Lease) {
		scheduleCredentialRenewal(current, () => {
			if (lease === current && !closed && !current.closing)
				void connect(["llm"]).catch(() => {});
		});
	}
	async function connect(
		required: Capability[],
		signal?: AbortSignal,
		force = false,
		requestProfile = false,
	): Promise<Lease> {
		signal?.throwIfAborted();
		signal = preparationSignal(lifetime.signal, signal);
		const scopedControl = (
			path: string,
			init: RequestInit,
			accepted: number[],
		) => control(path, { ...init, signal }, accepted);
		const pause = (ms: number) =>
			wait(
				ms,
				signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
			);
		if (closed) throw new Error("larm_closed");
		if (!base) throw new Error("larm_base_url_unconfigured");
		if (!token) throw new Error("larm_unconfigured");
		if (!profile) throw new Error("larm_profile_missing");
		if (!retained && lease && !lease.useCount && lease.idleAt <= Date.now())
			discard(lease);
		if (
			!force &&
			!requestProfile &&
			lease &&
			!lease.closing &&
			lease.expiresAt > Date.now() + 180_000 &&
			required.every((name) => lease!.providers.has(name))
		)
			return lease;
		if (connecting) {
			// A renewal in flight must not stop new work on a lease that is still valid.
			if (
				!force &&
				lease &&
				!lease.closing &&
				lease.expiresAt - Date.now() > 30_000 &&
				required.every((name) => lease!.providers.has(name))
			)
				return lease;
			try {
				await untilAborted(connecting, signal ?? lifetime.signal);
			} catch (error) {
				(signal ?? lifetime.signal).throwIfAborted();
				// The attempt belongs to another caller; its own cancellation or
				// deadline (AbortError / TimeoutError) must not fail this caller.
				if (
					!(
						error instanceof DOMException &&
						(error.name === "AbortError" || error.name === "TimeoutError")
					)
				)
					throw error;
			}
			return connect(required, signal, force, requestProfile);
		}
		const connectStarted = performance.now();
		// One key per connect(): every attempt to create this connection reuses it.
		const idempotencyKey = crypto.randomUUID();
		checkingProfile = requestProfile;
		log[requestProfile ? "debug" : "info"]("larm.connection_started", {
			count: required.length,
		});
		connecting = (async () => {
			if (lease && !lease.closing) {
				const current = lease;
				try {
					if (
						(await refresh(current, required, signal)) &&
						lease === current &&
						!current.closing
					) {
						if (requestProfile) await repeatProfile(control, current, signal);
						signal?.throwIfAborted();
						lastError = undefined;
						return current;
					}
				} catch (error) {
					if (
						!(error instanceof Error) ||
						![
							"larm_expired",
							"larm_connection_failed",
							"larm_connection_expired",
							"larm_connection_released",
							"larm_control_404",
						].includes(error.message)
					)
						throw error;
					discard(current, error.message);
				}
				for (let attempt = 0; current.useCount > 0 && attempt < 120; attempt++)
					await pause(1000);
				if (current.useCount > 0) throw new Error("larm_connection_busy");
				await release(current);
			}
			const current = await establishLease(
				{
					control,
					scopedControl,
					pause,
					hosts: hostsFor,
					profile,
					client,
					audience,
					idleTimeoutMs,
					lifetime: lifetime.signal,
				},
				required,
				signal,
				idempotencyKey,
			);
			lease = current;
			scheduleRenew(current);
			scheduleIdle(current);
			lastError = undefined;
			return current;
		})();
		notify();
		try {
			const connected = await connecting;
			log[requestProfile ? "debug" : "info"]("larm.connection_ready", {
				connectionId: connected.id,
				leaseExpiresAt: connected.expiresAt,
				count: connected.providers.size,
				durationMs: Math.round(performance.now() - connectStarted),
			});
			return connected;
		} catch (error) {
			if (callerAborted(error, signal))
				// The caller gave up; LARM did not fail, so the status stays as it was.
				log.info("larm.connection_failed", {
					reason: "caller_aborted",
					durationMs: Math.round(performance.now() - connectStarted),
				});
			else {
				log.warn(
					"larm.connection_failed",
					{
						connectionId: lease?.id,
						leaseExpiresAt: lease?.expiresAt,
						durationMs: Math.round(performance.now() - connectStarted),
					},
					error,
				);
				lastError = isNetworkError(error)
					? "larm_connection_failed"
					: toErrorCode(error, "larm_failed");
			}
			throw error;
		} finally {
			connecting = undefined;
			checkingProfile = false;
			notify();
		}
	}
	const refresh = createRefresh({
		control,
		profile,
		hostsFor,
		lifetime: lifetime.signal,
		isCurrent: (candidate) => lease === candidate,
		release,
		scheduleRenew,
	});
	const withProvider = createWithProvider({
		connect: (_required, signal, force) => connect(["llm"], signal, force),
		release,
		discard,
		scheduleIdle,
		control,
		idleTimeoutMs,
	});
	const retention = createProfileRetention(
		async (signal) => {
			if (base && token && profile) await connect(["llm"], signal, true, true);
		},
		(active) => {
			retained = active;
			if (lease && !closed) scheduleIdle(lease);
		},
	);
	if (keepAlive) retention.set(true);
	return {
		retain(active: boolean) {
			if (!closed) retention.set(active || keepAlive);
		},
		status,
		connect,
		withProvider,
		/** The lease in use now, if any. */
		current: () => lease,
		onChange: changes.onChange,
		/**
		 * Ends the port: `beforeRelease` stops the work that still borrows the lease. `keepConnection` leaves the
		 * connection to LARM's expiry, so a restarted host with the same client gets it back with its input cache.
		 */
		async close(beforeRelease: () => Promise<void>, keepConnection = false) {
			closed = true;
			retention.set(false);
			clearTimeout(lease?.idleTimer);
			lifetime.abort(new Error("larm_closed"));
			await beforeRelease();
			if (connecting) await connecting.catch(() => {});
			if (lease) {
				const current = lease;
				// Marked first: a call still running when the drain ends must not release it either.
				if (keepConnection) current.kept = true;
				await drainLease(current);
				await release(current, true);
			}
			changes.close();
		},
	};
}
