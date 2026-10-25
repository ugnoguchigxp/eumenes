import type { Lease, ProviderName } from "./profiles";

/** What the lease held now tells synchronously: the decision model and the LLM provider's window. */
export function leasePort(leases: {
	current(name?: ProviderName): Lease | undefined;
}) {
	return {
		decisionModel: () =>
			leases.current("system-one")?.providers.get("system-one")?.model ??
			(leases
				.current("system-one")
				?.catalogProviders?.find((p) => p.name === "system-one")?.model as
				| string
				| undefined) ??
			null,
		llmContextWindow: () =>
			leases.current("llm")?.providers.get("llm")?.contextWindow?.maxTokens ??
			null,
	};
}
