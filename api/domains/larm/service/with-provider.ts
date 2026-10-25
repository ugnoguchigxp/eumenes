import { pendingRenewal } from "./renew-lifetime";
import { measureStage } from "../../../infrastructure/performance";
import { withLogContext } from "../../../infrastructure/logger";
import type { Lease, Provider, ProviderName } from "./profiles";
import type { Control } from "./connect";
import { readJson, record, untilAborted } from "./guards";
import { LarmInferenceError } from "./inference-error";

/** Borrows a provider of the shared lease for one use and retires a lease the gateway has released. */
export function createWithProvider({
	connect,
	release,
	discard,
	scheduleIdle,
	control,
	idleTimeoutMs,
}: {
	connect: (
		required: ProviderName[],
		signal?: AbortSignal,
		force?: boolean,
	) => Promise<Lease>;
	release: (current: Lease, force?: boolean) => Promise<void>;
	discard: (current: Lease, error?: string) => void;
	scheduleIdle: (current: Lease) => void;
	control: Control;
	idleTimeoutMs: number;
}) {
	async function isReleased(
		current: Lease,
		signal: AbortSignal,
	): Promise<boolean> {
		if (current.closing) return true;
		const response = await control(
			`/v1/agent-connections/${encodeURIComponent(current.id)}`,
			{ method: "GET", signal },
			[200, 404, 410],
		);
		if (response.status !== 200) {
			await response.body?.cancel();
			return true;
		}
		const state = record(await readJson(response));
		return (
			state.id === current.id &&
			["released", "expired"].includes(String(state.status))
		);
	}
	return async function withProvider<T>(
		name: ProviderName,
		signal: AbortSignal,
		use: (p: Provider, connectionId: string) => Promise<T>,
	): Promise<T> {
		const required: ProviderName[] =
			name === "tts-english" ? ["tts", name] : [name];
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			const current = await measureStage(
				"larm",
				"provider_ready",
				() => untilAborted(connect(required, signal), signal),
				{ kind: name },
			);
			const renewal = pendingRenewal(current);
			if (renewal) {
				await untilAborted(renewal, signal);
				continue;
			}
			const provider = current.providers.get(name);
			if (name === "tts-english" && !provider)
				throw new Error("speech_tts_target_unavailable");
			if (name === "system-one" && !provider)
				throw new Error("larm_system_one_unavailable");
			if (
				!provider ||
				(provider.expiresAt ?? current.expiresAt) <= Date.now() + 10_000 ||
				current.closing
			)
				throw new Error("larm_credential_expired");
			current.useCount++;
			clearTimeout(current.idleTimer);
			const selected = provider;
			try {
				signal.throwIfAborted();
				const result = await withLogContext(
					{ connectionId: current.id, leaseExpiresAt: current.expiresAt },
					() => use(selected, current.id),
				);
				signal.throwIfAborted();
				return result;
			} catch (error) {
				let unusable =
					error instanceof LarmInferenceError &&
					error.status === 409 &&
					error.code === "connection_idle_released";
				if (unusable && name !== "llm") {
					try {
						unusable = await isReleased(current, signal);
					} catch {
						signal.throwIfAborted();
						throw error;
					}
					if (!unusable) {
						// Audio credentials belong to independent child Allocations. A child idle
						// rejection says nothing about the public Connection or its siblings.
						if (current.providers.get(name) === selected)
							current.providers.delete(name);
						if (!attempt && !signal.aborted) continue;
						throw error;
					}
				}
				// Some gateway versions return unauthorized after an idle profile switch.
				// Confirm the old connection is terminal; a ready connection's 401 stays an error.
				if (
					!signal.aborted &&
					error instanceof LarmInferenceError &&
					error.status === 401 &&
					error.code === "unauthorized"
				) {
					try {
						unusable = await isReleased(current, signal);
					} catch {
						signal.throwIfAborted();
					}
				}
				if (unusable) {
					discard(current, "larm_connection_released");
					// The gateway rejected before inference began. Only this explicit
					// lifecycle rejection may replay once; streamed output is never replayed.
					if (!attempt && !signal.aborted) continue;
				}
				throw error;
			} finally {
				current.useCount--;
				if (current.closing && current.useCount === 0) await release(current);
				else if (!current.closing && !current.useCount) {
					current.idleAt = Date.now() + idleTimeoutMs;
					scheduleIdle(current);
				}
			}
		}
	};
}
