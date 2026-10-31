import { record } from "./guards";

/** Preserve the existing selection: only managed main agents request a capacity. */
export function requestedContextTokens(role?: "main" | "sub") {
	return role === "main" ? 200000 : undefined;
}

/** Catalog capacity is an upper bound; the claim is the allocated window used for budgets. */
export function assertClaimContextWindow(
	declared: Record<string, unknown>,
	announced: Record<string, unknown> | undefined,
	claimed: Record<string, unknown>,
	requested?: number,
) {
	const maximum = record(declared.contextWindow);
	const actual = record(claimed.contextWindow);
	const ready = record(announced?.contextWindow ?? {});
	const positive = (value: unknown): value is number =>
		typeof value === "number" && Number.isSafeInteger(value) && value > 0;
	if (
		!positive(maximum.maxTokens) ||
		!positive(actual.maxTokens) ||
		actual.maxTokens > maximum.maxTokens ||
		(requested !== undefined &&
			(!positive(requested) || actual.maxTokens !== requested)) ||
		(announced?.contextWindow !== undefined &&
			(!positive(ready.maxTokens) || ready.maxTokens !== actual.maxTokens)) ||
		Object.entries(maximum).some(
			([key, value]) => key !== "maxTokens" && actual[key] !== value,
		)
	)
		throw new Error("larm_claim_context_mismatch");
}
