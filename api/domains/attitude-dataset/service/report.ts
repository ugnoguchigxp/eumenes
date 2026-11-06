import { emotionSchema } from "../../delivery";
import { coverageTags, type Sample } from "../contracts";

export function datasetReport<T extends object>(
	data: Sample[],
	status: () => T,
) {
	const counts = Object.fromEntries(emotionSchema.options.map((k) => [k, 0]));
	const coverage = Object.fromEntries(coverageTags.map((k) => [k, 0]));
	const differences: unknown[] = [];
	for (const s of data) {
		for (const tag of s.coverage_tags) coverage[tag] = (coverage[tag] ?? 0) + 1;
		if (s.review_status === "reviewed" && s.primary_label) {
			counts[s.primary_label] = (counts[s.primary_label] ?? 0) + 1;
			if (
				s.decision.top_label !== s.primary_label ||
				s.decision.api_label !== s.primary_label
			)
				differences.push({
					sample_id: s.sample_id,
					model_top: s.decision.top_label,
					api_label: s.decision.api_label,
					primary_label: s.primary_label,
					acceptable_labels: s.acceptable_labels,
					reason: s.correction_reason,
				});
		}
	}
	const contrast = new Map<string, Sample[]>();
	for (const s of data) {
		const key = s.current_chunk.trim();
		contrast.set(key, [...(contrast.get(key) ?? []), s]);
	}
	const contrasts = [...contrast.values()]
		.filter((g) => new Set(g.map((s) => s.user_utterance)).size > 1)
		.map((g) => ({
			sample_ids: g.map((s) => s.sample_id),
			reviewed: g.filter((s) => s.review_status === "reviewed").length,
		}));
	const reviewedCount = data.filter(
		(s) => s.review_status === "reviewed",
	).length;
	return {
		...status(),
		contrasting_context_groups: contrasts,
		short_texts: data.filter((s) => Array.from(s.current_chunk).length <= 20)
			.length,
		dominant_class_fraction: reviewedCount
			? Math.max(...Object.values(counts)) / reviewedCount
			: null,
		classes: counts,
		rejections: Object.fromEntries(
			[...new Set(data.map((s) => s.rejection_reason).filter(Boolean))].map(
				(reason) => [
					reason,
					data.filter((s) => s.rejection_reason === reason).length,
				],
			),
		),
		coverage,
		missing_classes: Object.keys(counts).filter((k) => !counts[k]),
		missing_coverage: Object.keys(coverage).filter((k) => !coverage[k]),
		differences,
		granularity: {
			answer: data.filter((s) => s.granularity === "answer").length,
			chunk: data.filter((s) => s.granularity === "chunk").length,
		},
		splits: Object.fromEntries(
			["train", "calibration", "eval"].map((k) => [
				k,
				data.filter((s) => s.split === k).length,
			]),
		),
		warnings: [
			"不足は実会話から収集してください。合成例・速度測定を300件に含めません。",
			"類似テンプレートは人手で同じtemplate_group_idへ統合し、確認してください。",
			"evalを分類ヘッド学習・温度校正・閾値調整に使わないでください。",
		],
	};
}
