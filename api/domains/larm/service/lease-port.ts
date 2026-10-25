import {
	protocols,
	endpoints,
	type Lease,
	type ProviderName,
} from "./profiles";

/** What the lease held now tells synchronously: the decision model and the LLM provider's window. */
export function leasePort(leases: {
	current(name?: ProviderName): Lease | undefined;
}) {
	return {
		decisionModel: () => {
			const current = leases.current("system-one");
			const claimed = current?.providers.get("system-one");
			if (claimed) return claimed.model;
			const declared = current?.catalogProviders?.find(
				(p) =>
					p.name === "system-one" &&
					p.capability === "decision.system-one" &&
					p.protocol === protocols["system-one"] &&
					p.endpoint === endpoints["system-one"],
			);
			const model = declared?.model;
			return typeof model === "string" &&
				model.length > 0 &&
				model.length <= 4096
				? model
				: null;
		},
		llmContextWindow: () =>
			leases.current("llm")?.providers.get("llm")?.contextWindow?.maxTokens ??
			null,
	};
}
