import {
	isNetworkError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
import type { Capability, LarmStatus } from "../contracts";
import type { Lease } from "./profiles";
import { type Control, type ProviderHosts } from "./connect";
import { establishLease } from "./establish";
import { leaseStatus } from "./lease-status";
import { createRefresh } from "./refresh";
import { createWithProvider } from "./with-provider";
import { callerAborted, untilAborted, wait } from "./guards";

const log = getLogger("larm");

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
	hostsFor: () => ProviderHosts;
	control: Control;
	/** Aborted when the port closes. */
	lifetime: AbortController;
}) {
	let lease: Lease | undefined;
	let connecting: Promise<Lease> | undefined;
	let lastError: string | undefined;
	let closed = false;
	const listeners = new Set<() => void>();
	const status = (): LarmStatus =>
		leaseStatus({
			configured: !!token && !!base && !!profile,
			baseConfigured: !!base,
			profileSaved: !!profile,
			connecting: !!connecting,
			lastError,
			lease,
		});
	let previousStatus = JSON.stringify(status());
	function notify() {
		const next = JSON.stringify(status());
		if (previousStatus === next) return;
		previousStatus = next;
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				/* Independent subscribers. */
			}
		}
	}
	async function release(current: Lease, force = false) {
		current.closing = true;
		if (current.renewTimer) clearTimeout(current.renewTimer);
		clearTimeout(current.idleTimer);
		if (current.useCount > 0 && !force) return;
		if (lease === current) lease = undefined;
		notify();
		try {
			await control(
				`/v1/agent-connections/${encodeURIComponent(current.id)}`,
				{ method: "DELETE" },
				[204, 200, 404, 410],
			);
		} catch {
			if (!lease) {
				lastError = "larm_release_unconfirmed";
				notify();
			}
		}
	}
	function discard(current: Lease, error?: string) {
		current.closing = true;
		clearTimeout(current.renewTimer);
		clearTimeout(current.idleTimer);
		if (lease === current) {
			lease = undefined;
			lastError = error;
			notify();
		}
	}
	function scheduleIdle(current: Lease) {
		clearTimeout(current.idleTimer);
		current.idleTimer = setTimeout(
			() => {
				if (lease === current && !current.useCount) discard(current);
			},
			Math.max(0, current.idleAt - Date.now()),
		);
		current.idleTimer.unref?.();
	}
	function scheduleRenew(current: Lease) {
		if (current.renewTimer) clearTimeout(current.renewTimer);
		const delay = Math.max(0, current.expiresAt - Date.now() - 180_000);
		current.renewTimer = setTimeout(() => {
			if (lease === current && !closed && !current.closing)
				void connect(["llm"]).catch(() => {});
		}, delay);
		current.renewTimer.unref?.();
	}
	async function connect(
		required: Capability[],
		signal?: AbortSignal,
		force = false,
	): Promise<Lease> {
		signal?.throwIfAborted();
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
		if (lease && !lease.useCount && lease.idleAt <= Date.now()) discard(lease);
		if (
			!force &&
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
			return connect(required, signal, force);
		}
		const connectStarted = performance.now();
		// One key per connect(): every attempt to create this connection reuses it.
		const idempotencyKey = crypto.randomUUID();
		log.info("larm.connection_started", { count: required.length });
		connecting = (async () => {
			if (lease && !lease.closing) {
				const current = lease;
				try {
					if (
						(await refresh(current, required, signal)) &&
						lease === current &&
						!current.closing
					) {
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
			log.info("larm.connection_ready", {
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
					{ durationMs: Math.round(performance.now() - connectStarted) },
					error,
				);
				lastError = isNetworkError(error)
					? "larm_connection_failed"
					: toErrorCode(error, "larm_failed");
			}
			throw error;
		} finally {
			connecting = undefined;
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
		connect,
		release,
		discard,
		scheduleIdle,
		control,
		idleTimeoutMs,
	});
	return {
		status,
		connect,
		withProvider,
		/** The lease in use now, if any. */
		current: () => lease,
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Ends the port: `beforeRelease` stops the work that still borrows the lease. */
		async close(beforeRelease: () => Promise<void>) {
			closed = true;
			lifetime.abort(new Error("larm_closed"));
			await beforeRelease();
			if (connecting) await connecting.catch(() => {});
			if (lease) {
				const current = lease;
				// Let in-flight work finish (up to 5 s) so the DELETE is not skipped.
				const idle = new AbortController().signal;
				for (
					let waited = 0;
					current.useCount > 0 && waited < 5_000;
					waited += 100
				)
					await wait(100, idle);
				await release(current, true);
			}
			listeners.clear();
		},
	};
}
