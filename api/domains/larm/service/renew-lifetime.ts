import type { Control } from "./connect";
import type { Lease } from "./profiles";
import { readJson, record, string, untilAborted, wait } from "./guards";

const renewing = new WeakMap<Lease, Promise<void>>();
const generations = new WeakMap<Lease, number>();

export function credentialGeneration(current: Lease) {
	return generations.get(current) ?? 0;
}

/** LARM renew rotates all credentials. Retire them atomically, then reclaim each on demand. */
export async function renewLifetime(
	current: Lease,
	control: Control,
	caller: AbortSignal,
) {
	let work = renewing.get(current);
	if (!work) {
		const signal = AbortSignal.timeout(60_000);
		work = (async () => {
			while (current.useCount > 0) {
				if (current.closing) throw new Error("larm_connection_released");
				await wait(100, signal);
			}
			if (current.closing) throw new Error("larm_connection_released");
			// A lost response may already have changed the generation.
			generations.set(current, credentialGeneration(current) + 1);
			current.providers.clear();
			const response = await control(
				`/v1/agent-connections/${current.id}/renew`,
				{
					method: "POST",
					signal,
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": crypto.randomUUID(),
					},
					body: JSON.stringify({ ttlSeconds: 900 }),
				},
				[200, 201],
			);
			// Even a malformed renewal may have rotated every token. Never keep the old generation.
			current.providers.clear();
			const state = record(await readJson(response));
			if (
				state.id !== current.id ||
				["released", "expired"].includes(String(state.status))
			)
				throw new Error("larm_renew_invalid");
			const expiresAt = Date.parse(string(state.expiresAt));
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 180_000)
				throw new Error("larm_renew_expired");
			current.expiresAt = expiresAt;
			current.state = state;
		})();
		renewing.set(current, work);
		void work.finally(() => renewing.delete(current)).catch(() => {});
	}
	await untilAborted(work, caller);
}

export function pendingRenewal(current: Lease) {
	return renewing.get(current);
}
