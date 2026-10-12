import type { LarmPort } from "../api/domains/larm";
import { emotionSchema, speechQuestions } from "../api/domains/delivery";

const texts = {
	ja: "これは日本語の文章です。",
	en: "This is an English sentence.",
} as const;
function summary(values: number[], failed: number) {
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (p: number) =>
		sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
	return {
		completed: values.length,
		failed,
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		maxMs: sorted.at(-1) ?? null,
	};
}
/** Transport timings from the Eumenes host; includes HTTP and result validation, excludes admission. */
export async function benchmarkSentenceLanguage(larm: LarmPort, count = 200) {
	const connections = new Set<string>();
	const onExchange = async (x: { connectionId: string }) => {
		connections.add(x.connectionId);
	};
	const results: Record<string, unknown> = {};
	for (const mode of ["ja", "en", "parallel-attitude"] as const) {
		const times: number[] = [];
		let failed = 0,
			consecutiveFailures = 0;
		for (let i = 0; i < count; i++) {
			const language =
				mode === "parallel-attitude" ? (i % 2 ? "en" : "ja") : mode;
			const start = performance.now();
			try {
				const signal = AbortSignal.timeout(2000);
				const work = larm.classifySentenceLanguage!(texts[language], signal, {
					onExchange,
				});
				const attitude =
					mode === "parallel-attitude"
						? larm.judge!(
								{ current_chunk: "ありがとうございます。" },
								speechQuestions,
								signal,
							)
						: Promise.resolve(undefined);
				const [decision, raw] = await Promise.all([work, attitude]);
				if (decision.language !== language)
					throw new Error("language_label_mismatch");
				if (raw) {
					const body = raw as {
						claimed_model?: string;
						answers?: { emotion?: { choice?: unknown } };
					};
					if (
						body.claimed_model !== larm.decisionModel!() ||
						!emotionSchema.safeParse(body.answers?.emotion?.choice).success
					)
						throw new Error("attitude_contract_invalid");
				}
				times.push(performance.now() - start);
				consecutiveFailures = 0;
			} catch {
				failed++;
				consecutiveFailures++;
			}
			if (consecutiveFailures >= 3) break;
		}
		results[mode] = { planned: count, ...summary(times, failed) };
	}
	return {
		conditions: results,
		connectionCount: connections.size,
		connections: [...connections],
	};
}
