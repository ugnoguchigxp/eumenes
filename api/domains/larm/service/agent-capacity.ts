import { record, string } from "./guards";

export function assertAgentCapacity(
	info: Record<string, unknown>,
	role: "main" | "sub",
) {
	if (
		record(info.contextWindow).maxTokens !== (role === "main" ? 200000 : 131072)
	)
		throw new Error("larm_agent_context_mismatch");
}

/** Provider credentials may expire before the connection lease. */
export function claimExpiry(claim: Record<string, unknown>) {
	const expiry = Date.parse(string(claim.expiresAt));
	const providers = Array.isArray(claim.providers)
		? claim.providers.map(record)
		: [];
	return Math.min(
		expiry,
		...providers.flatMap((provider) => {
			const credential = record(provider.credential);
			return credential.expiresAt === undefined
				? []
				: [Date.parse(string(credential.expiresAt))];
		}),
	);
}
