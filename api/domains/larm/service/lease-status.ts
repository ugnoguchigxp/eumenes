import type { Capability, LarmStatus } from "../contracts";
import type { Lease } from "./profiles";

/** Notify only actual status changes; a routine Profile-use POST does not flicker ready. */
export function createStatusChanges(status: () => LarmStatus) {
	const listeners = new Set<() => void>();
	let previous = JSON.stringify(status());
	return {
		notify() {
			const next = JSON.stringify(status());
			if (next === previous) return;
			previous = next;
			for (const listener of listeners) {
				try {
					listener();
				} catch {
					/* Independent subscribers. */
				}
			}
		},
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			listeners.clear();
		},
	};
}

/** What the port reports about its connection, from the facts the lease manager holds. */
export function leaseStatus({
	configured,
	baseConfigured,
	profileSaved,
	connecting,
	lastError,
	lease,
}: {
	/** Token, control origin and saved profile are all present. */
	configured: boolean;
	baseConfigured: boolean;
	profileSaved: boolean;
	connecting: boolean;
	lastError: string | undefined;
	lease: Lease | undefined;
}): LarmStatus {
	return {
		state: !configured
			? "unconfigured"
			: connecting
				? "connecting"
				: lastError
					? "failed"
					: lease
						? "ready"
						: "idle",
		...(lease?.providers.get("llm")?.vision &&
		lease.providers.get("llm")?.chatInput
			? { chatInput: lease.providers.get("llm")!.chatInput }
			: {}),
		capabilities: lease
			? [...lease.providers.keys()].filter(
					(name): name is Capability =>
						name === "llm" || name === "asr" || name === "tts",
				)
			: [],
		...(!baseConfigured
			? { error: "larm_base_url_unconfigured" }
			: !profileSaved
				? { error: "larm_profile_missing" }
				: lastError
					? { error: lastError }
					: {}),
	};
}
