import type { Capability, LarmStatus } from "../contracts";
import type { Lease } from "./profiles";

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
