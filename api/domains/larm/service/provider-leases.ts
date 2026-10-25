import {
	isNetworkError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmStatus } from "../contracts";
import type { Lease, Provider, ProviderName } from "./profiles";
import type { Control, ProviderHosts } from "./connect";
import { createLeaseManager } from "./lease-manager";
import { createVoiceLease } from "./voice-lease";
import { drainLease } from "./drain-lease";
import { leaseStatus, createStatusChanges } from "./lease-status";
import { acquireProvider } from "./acquire-provider";
import { createProfileRetention, repeatProfile } from "./profile-retention";
import { createWithProvider } from "./with-provider";
import { callerAborted, untilAborted } from "./guards";
const log = getLogger("larm");
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

type Options = {
	base: URL | undefined;
	token: string | undefined;
	profile: string;
	audience: string;
	client: string;
	idleTimeoutMs: number;
	keepAlive?: boolean;
	hostsFor: () => ProviderHosts;
	control: Control;
	lifetime: AbortController;
};

/** LARM identifies different Provider scopes as different Connections, even for the same client. */
export function createProviderLeases(options: Options) {
	const main = createLeaseManager(options);
	let voice: ReturnType<typeof createScope> | undefined;
	let retained = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	main.onChange(notify);
	const speech = () => {
		if (!voice) {
			voice = createScope(options);
			voice.onChange(notify);
			if (retained) voice.retain(true);
		}
		return voice;
	};
	return {
		retain(active: boolean) {
			retained = active;
			// An existing audio scope is enough to keep a visible chat warm.
			if (main.current() || !voice) main.retain(active);
			voice?.retain(active);
		},
		status(): LarmStatus {
			const m = main.status(),
				v = voice?.status();
			const selected = m.state === "ready" ? m : v?.state === "ready" ? v : m;
			return {
				...selected,
				capabilities: [
					...new Set([...m.capabilities, ...(v?.capabilities ?? [])]),
				],
			};
		},
		connect(required: ProviderName[], signal?: AbortSignal, force = false) {
			return required.every((n) => n === "llm")
				? main.connect(["llm"], signal, force)
				: speech().connect(required, signal, force);
		},
		withProvider<T>(
			name: ProviderName,
			signal: AbortSignal,
			use: (p: Provider, id: string) => Promise<T>,
		) {
			return (name === "llm" ? main : speech()).withProvider(name, signal, use);
		},
		current(name?: ProviderName) {
			return name === "llm"
				? main.current()
				: name
					? voice?.current()
					: (main.current() ?? voice?.current());
		},
		providers() {
			return new Map([
				...(main.current()?.providers ?? []),
				...(voice?.current()?.providers ?? []),
			]);
		},
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async close(beforeRelease: () => Promise<void>, keepConnection = false) {
			await Promise.all([
				main.close(beforeRelease, keepConnection),
				voice?.close(async () => {}, keepConnection),
			]);
			listeners.clear();
		},
	};
}

/** Shares acquisition only; each Provider waits, fails and refreshes independently. */
function createScope({
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
}: Options) {
	let lease: Lease | undefined;
	let creating: Promise<Lease> | undefined;
	const pending = new Set<Promise<Lease>>();
	let lastError: string | undefined;
	let closed = false,
		retained = false;
	const status = (): LarmStatus =>
		leaseStatus({
			configured: !!token && !!base && !!profile,
			baseConfigured: !!base,
			profileSaved: !!profile,
			connecting: !!creating || (!lease?.providers.size && pending.size > 0),
			lastError,
			lease: lease?.providers.size ? lease : undefined,
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
			lastError = "larm_release_unconfirmed";
			notify();
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
				if (lease === current && !current.useCount && !pending.size)
					discard(current);
			},
			Math.max(0, current.idleAt - Date.now()),
		);
		current.idleTimer.unref?.();
	}
	function scheduleRenew(current: Lease) {
		clearTimeout(current.renewTimer);
		if (!current.providers.size) return;
		const expiry = Math.min(
			...[...current.providers.values()].map(
				(p) => p.expiresAt ?? current.expiresAt,
			),
		);
		current.renewTimer = setTimeout(
			() => {
				if (lease !== current || closed || current.closing) return;
				for (const [name, p] of current.providers)
					if ((p.expiresAt ?? current.expiresAt) <= Date.now() + 180_000)
						void connect([name], undefined, true).catch(() => {});
			},
			Math.max(1000, expiry - Date.now() - 180_000),
		);
		current.renewTimer.unref?.();
	}
	async function getLease(signal: AbortSignal) {
		if (lease && !lease.closing) return lease;
		if (!creating) {
			const creationSignal = AbortSignal.any([
				lifetime.signal,
				AbortSignal.timeout(60_000),
			]);
			const work = createVoiceLease(
				{
					scopedControl: (path, init, accepted) =>
						control(path, { ...init, signal: creationSignal }, accepted),
					profile,
					client,
					audience,
					idleTimeoutMs,
					fullProfile: true,
					lifetime: lifetime.signal,
				},
				["asr", "tts"],
				crypto.randomUUID(),
			).then((current) => {
				lease = current;
				scheduleIdle(current);
				return current;
			});
			creating = work;
			void work
				.finally(() => {
					if (creating === work) creating = undefined;
					notify();
				})
				.catch(() => {});
		}
		return untilAborted(creating, signal);
	}
	async function connect(
		required: ProviderName[],
		caller?: AbortSignal,
		force = false,
	): Promise<Lease> {
		caller?.throwIfAborted();
		if (closed) throw new Error("larm_closed");
		if (!base) throw new Error("larm_base_url_unconfigured");
		if (!token) throw new Error("larm_unconfigured");
		if (!profile) throw new Error("larm_profile_missing");
		const signal = AbortSignal.any([
			lifetime.signal,
			AbortSignal.timeout(60_000),
			...(caller ? [caller] : []),
		]);
		if (
			!retained &&
			lease &&
			!lease.useCount &&
			!pending.size &&
			lease.idleAt <= Date.now()
		)
			discard(lease);
		const work = (async () => {
			for (let attempt = 0; ; attempt++) {
				const current = await getLease(signal);
				try {
					for (const name of required) {
						const p = current.providers.get(name);
						if (
							!force &&
							p &&
							(p.expiresAt ?? current.expiresAt) > Date.now() + 180_000
						)
							continue;
						await acquireProvider(current, name, control, hostsFor(), signal);
					}
					signal.throwIfAborted();
					if (lease !== current || current.closing) continue;
					lastError = undefined;
					scheduleRenew(current);
					return current;
				} catch (error) {
					if (
						error instanceof Error &&
						[
							"larm_expired",
							"larm_connection_expired",
							"larm_connection_released",
							"larm_control_404",
							"larm_control_410",
						].includes(error.message)
					) {
						discard(current, error.message);
						if (!attempt) continue;
					}
					throw error;
				}
			}
		})();
		pending.add(work);
		notify();
		try {
			return await work;
		} catch (error) {
			if (!callerAborted(error, caller)) {
				lastError = isNetworkError(error)
					? "larm_connection_failed"
					: toErrorCode(error, "larm_failed");
				log.warn("larm.provider_preparation_failed", {
					kind: required.join(","),
					connectionId: lease?.id,
					reason: lastError,
				});
			}
			throw error;
		} finally {
			pending.delete(work);
			if (lease) scheduleIdle(lease);
			notify();
		}
	}
	const withProvider = createWithProvider({
		connect,
		release,
		discard,
		scheduleIdle,
		control,
		idleTimeoutMs,
	});
	const retention = createProfileRetention(
		async (signal) => {
			if (!base || !token || !profile) return;
			const current = await getLease(signal);
			await repeatProfile(control, current, signal);
			if (!current.providers.size) await connect(["asr"], signal);
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
		current: () => lease,
		onChange: changes.onChange,
		async close(beforeRelease: () => Promise<void>, keepConnection = false) {
			closed = true;
			retention.set(false);
			if (lease && keepConnection) lease.kept = true;
			lifetime.abort(new Error("larm_closed"));
			await beforeRelease();
			if (creating) await creating.catch(() => {});
			await Promise.allSettled(pending);
			if (lease) {
				const current = lease;
				if (keepConnection) current.kept = true;
				await drainLease(current);
				await release(current, true);
			}
			changes.close();
		},
	};
}
