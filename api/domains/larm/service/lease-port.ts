import type { Lease } from "./profiles";

/** What the lease held now tells synchronously: the decision model and the LLM provider's window. */
export function leasePort(leases: { current(): Lease | undefined }) {
	return {
		decisionModel: () =>
			leases.current()?.providers.get("system-one")?.model ?? null,
		llmContextWindow: () =>
			leases.current()?.providers.get("llm")?.contextWindow?.maxTokens ?? null,
	};
}
