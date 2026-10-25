import { createConnection, type Control } from "./connect";
import { record, string } from "./guards";
import type { Lease } from "./profiles";

export function scheduleCredentialRenewal(current: Lease, check: () => void) {
	clearTimeout(current.renewTimer);
	current.renewTimer = setTimeout(
		check,
		Math.max(0, current.expiresAt - Date.now() - 180_000),
	);
	current.renewTimer.unref?.();
}

/** Repeats the existing Profile-use request. A replacement is never an ownership extension. */
export async function repeatProfile(
	control: Control,
	current: Lease,
	signal?: AbortSignal,
) {
	const { id, created } = await createConnection(
		(path, init, accepted) => control(path, { ...init, signal }, accepted),
		{ ...current.request, idempotencyKey: crypto.randomUUID() },
	);
	if (id !== current.id) {
		// This port's unique client owns the unexpected result; do not leak it or adopt it.
		await control(
			`/v1/agent-connections/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
			[200, 204, 404, 410],
		);
		throw new Error("larm_retention_connection_changed");
	}
	signal?.throwIfAborted();
	if (
		created.profile !== current.request.profile ||
		created.agentProfile !== current.agentProfile ||
		["released", "expired"].includes(String(created.status)) ||
		!Array.isArray(created.providers)
	)
		throw new Error("larm_invalid_connection");
	for (const name of ["llm", "asr", "tts"] as const) {
		const previous = current.providers.get(name);
		if (!previous) continue;
		const provider = created.providers
			.map(record)
			.find((item) => item.name === name);
		// claimable reflects a short-lived semantic probe cache, not this existing claim.
		if (
			!provider ||
			provider.model !== previous.model ||
			provider.protocol !== previous.protocol
		)
			throw new Error("larm_retention_provider_changed");
	}
	const expiresAt = Date.parse(string(created.expiresAt));
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
		throw new Error("larm_expired");
	// Extending Profile use says nothing about the expiry of already claimed credentials.
	current.expiresAt = Math.min(current.expiresAt, expiresAt);
}

/** One request at a time. Stopping also fences late completion and the next timer. */
export function createProfileRetention(
	check: (signal: AbortSignal) => Promise<void>,
	changed: (active: boolean) => void,
) {
	let owner: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		set(active: boolean) {
			if (active === !!owner) return;
			clearTimeout(timer);
			owner?.abort();
			owner = active ? new AbortController() : undefined;
			changed(active);
			if (!owner) return;
			const current = owner;
			async function tick() {
				try {
					await check(current.signal);
				} catch {
					/* Connection status records failures. */
				}
				if (current.signal.aborted) return;
				timer = setTimeout(tick, 30_000);
				timer.unref?.();
			}
			void tick();
		},
	};
}
