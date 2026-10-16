import { measureStage } from "../../../infrastructure/performance";
import type { Capability } from "../contracts";
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
		required: Capability[],
		signal?: AbortSignal,
		force?: boolean,
	) => Promise<Lease>;
	release: (current: Lease, force?: boolean) => Promise<void>;
	discard: (current: Lease, error?: string) => void;
	scheduleIdle: (current: Lease) => void;
	control: Control;
	idleTimeoutMs: number;
}) {
	/** Leases confirmed without an English voice; later English clauses skip the recheck. */
	const withoutEnglish = new WeakSet<Lease>();
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
		const required: Capability[] =
			name === "llm" ? ["llm"] : ["llm", "asr", "tts"];
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			let current = await measureStage(
				"larm",
				"provider_ready",
				() => untilAborted(connect(required, signal), signal),
				{ kind: name },
			);
			let provider = current.providers.get(name);
			if (name === "tts-english" && !provider && !withoutEnglish.has(current)) {
				// A pre-deployment voice lease may lack the newly published role.
				// Check its current control state before treating the role as absent.
				current = await untilAborted(connect(required, signal, true), signal);
				provider = current.providers.get(name);
				if (!provider) withoutEnglish.add(current);
			}
			if (name === "tts-english" && !provider)
				throw new Error("speech_tts_target_unavailable");
			if (name === "system-one" && !provider)
				throw new Error("larm_system_one_unavailable");
			if (
				!provider ||
				current.expiresAt <= Date.now() + 10_000 ||
				current.closing
			)
				throw new Error("larm_credential_expired");
			current.useCount++;
			clearTimeout(current.idleTimer);
			try {
				signal.throwIfAborted();
				return await use(provider, current.id);
			} catch (error) {
				let unusable =
					error instanceof LarmInferenceError &&
					error.status === 409 &&
					error.code === "connection_idle_released";
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
