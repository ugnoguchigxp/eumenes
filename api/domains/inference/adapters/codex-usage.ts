export type CodexUsage = {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningTokens: number | null;
	usageModel: string | null;
};
/** A thread's cumulative counters as the app-server reports them (`thread/tokenUsage/updated` → `total`). */
export type CodexTotals = {
	input: number | null;
	output: number | null;
	cached: number | null;
	cacheWrite: number | null;
	reasoning: number | null;
};
/** A thread that has taken no turn since it was created or reverted to its head has counted nothing. */
export const emptyTotals: CodexTotals = {
	input: 0,
	output: 0,
	cached: 0,
	cacheWrite: 0,
	reasoning: 0,
};
const count = (n: unknown) =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;

export function codexTotals(raw: unknown): CodexTotals | null {
	const total = (raw as { total?: Record<string, unknown> } | null)?.total;
	if (!total) return null;
	return {
		input: count(total.inputTokens),
		output: count(total.outputTokens),
		cached: count(total.cachedInputTokens),
		cacheWrite: count(total.cacheWriteInputTokens),
		reasoning: count(total.reasoningOutputTokens),
	};
}
const minus = (now: number | null, before: number | null) =>
	now === null ? null : count(now - (before ?? 0));

/**
 * The usage of one turn: the thread's cumulative total now, less the total the thread had when the turn began
 * (`baseline`; zero for a new or reverted thread). The thread total is not the call's amount once a thread is
 * reused, and `last` is one upstream completion, never used as the whole.
 */
export function codexUsage(
	raw: unknown,
	model: string | null,
	baseline: CodexTotals = emptyTotals,
): CodexUsage | null {
	const now = codexTotals(raw);
	if (!now) return null;
	const input = minus(now.input, baseline.input);
	const output = minus(now.output, baseline.output);
	if (input === null || output === null) return null;
	const cache = minus(now.cached, baseline.cached);
	const writes = minus(now.cacheWrite, baseline.cacheWrite);
	const reasoning = minus(now.reasoning, baseline.reasoning);
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
