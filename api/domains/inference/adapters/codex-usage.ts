export type CodexUsage = {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningTokens: number | null;
	usageModel: string | null;
};
const count = (n: unknown) =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;

/**
 * This transport always starts an ephemeral thread and runs exactly one turn.
 * Its thread total is therefore this attempt's cumulative usage, not last (one upstream completion).
 * A future resume path must subtract its pre-turn baseline before reusing this boundary.
 */
export function codexUsage(
	raw: unknown,
	model: string | null,
): CodexUsage | null {
	const total = (raw as { total?: Record<string, unknown> } | null)?.total;
	if (!total) return null;
	const input = count(total.inputTokens);
	const output = count(total.outputTokens);
	if (input === null || output === null) return null;
	const cache = count(total.cachedInputTokens);
	const writes = count(total.cacheWriteInputTokens);
	const reasoning = count(total.reasoningOutputTokens);
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cache !== null && cache <= input ? cache : null,
		cacheCreationTokens:
			writes !== null &&
			writes <= input &&
			(cache === null || writes + cache <= input)
				? writes
				: null,
		reasoningTokens:
			reasoning !== null && reasoning <= output ? reasoning : null,
		usageModel: model,
	};
}
