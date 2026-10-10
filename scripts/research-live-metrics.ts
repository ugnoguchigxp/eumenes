import type { Usage } from "../api/domains/inference";

/** Include every model attempt, including rejected repairs and the parent answer. */
export function researchLiveMetrics(
	usage: Usage[],
	runId: string,
	tasks: Array<{ id: string }>,
) {
	const calls = usage
		.filter(
			(u) =>
				u.purpose === "llm" &&
				(u.subject === runId ||
					tasks.some((t) => u.subject.startsWith(`agent:${t.id}:step:`))),
		)
		.sort((a, b) => a.started - b.started);
	const child = calls.filter((u) => u.subject !== runId);
	const firstChild = child[0]?.started ?? Infinity;
	const initial = calls.filter(
		(u) => u.subject === runId && u.started <= firstChild,
	);
	const final = calls.filter(
		(u) => u.subject === runId && u.started > firstChild,
	);
	const stage = (entries: Usage[]) => ({
		calls: entries.length,
		milliseconds: entries.reduce(
			(sum, u) => sum + Math.max(0, (u.ended ?? u.started) - u.started),
			0,
		),
	});
	return {
		totalModelCalls: calls.length,
		stages: {
			conversation: stage(initial),
			research: stage(child),
			answer: stage(final),
		},
		models: [
			...new Set(
				calls.flatMap((u) => [
					`${u.source}:${u.model}`,
					...(u.providerDetails ?? []).map(
						(p) => `${p.connectionId}:${p.model}`,
					),
				]),
			),
		],
	};
}
