/** RESULTS-ready output of an analysis: a JSON document and a Markdown table. */
import type { Analysis, Comparison } from "./analysis";
import type { PrefixReport } from "./prefix-measure";

export type ReportMeta = {
	experiment: string;
	generatedAt: string;
	/** sha256 of manifest.json when the experiment was frozen, else null. */
	manifestSha256: string | null;
	scoredFrom: string;
	/** sha256 of the run's prefix.json (the trajectory measurement criterion 7 reads), or null when the run has none. */
	prefixSha256: string | null;
	prefix: PrefixReport | null;
};

export function resultsJson(analysis: Analysis, meta: ReportMeta) {
	return {
		format: "context-eval.results",
		version: 1,
		...meta,
		lane: analysis.lane,
		split: analysis.split,
		binding: analysis.binding,
		baseline: analysis.baseline,
		thresholds: analysis.thresholds,
		expectedTrials: analysis.expectedTrials,
		caseCount: analysis.caseCount,
		comparisons: analysis.comparisons,
		verdicts: analysis.verdicts,
	};
}

const mark = { pass: "合格", fail: "不合格", not_measured: "未計測" } as const;
const decisionText = {
	adopt: "採用",
	reject: "不採用",
	incomplete: "判定不能（incomplete）",
	not_binding: "判定しない（採否に使えない）",
} as const;

function section(c: Comparison): string[] {
	const families = Object.entries(c.perFamily)
		.map(
			([family, d]) =>
				`${family}: +${d.improved} / -${d.regressed} (正味 ${d.net})`,
		)
		.join("、");
	return [
		`### ${c.arm} と ${c.baseline}`,
		"",
		`- 結論: **${decisionText[c.decision]}**`,
		...(c.reasons.length
			? ["- 満たしていない基準:", ...c.reasons.map((r) => `  - ${r}`)]
			: []),
		`- 比較できた事例 ${c.compared} 件。改善 ${c.improvements.length}、退行 ${c.regressions.length}、変化なし ${c.unchanged}、判定不能 ${c.incompleteCases.length}`,
		`- 族ごと: ${families || "なし"}`,
		`- 改善: ${c.improvements.join(", ") || "なし"}`,
		`- 退行: ${c.regressions.join(", ") || "なし"}`,
		"",
		"| # | 基準 | 結果 | 内訳 |",
		"| --- | --- | --- | --- |",
		...c.criteria.map(
			(k) => `| ${k.id} | ${k.name} | ${mark[k.status]} | ${k.detail} |`,
		),
		"",
	];
}

/** The trajectory measurement as a table: one row per arm (ordering variants included). */
function prefixTable(prefix: PrefixReport): string[] {
	const rows = Object.entries(prefix.arms).map(([arm, report]) => {
		const shared = report.calls.reduce(
			(sum, c) => sum + (c.sharedTokens ?? 0),
			0,
		);
		const total = report.calls.slice(1).reduce((sum, c) => sum + c.tokens, 0);
		return `| ${arm} | ${report.medianRatio?.toFixed(3) ?? "n/a"} | ${report.medianByteRatio?.toFixed(3) ?? "n/a"} | ${report.aggregateRatio?.toFixed(3) ?? "n/a"} | ${shared} | ${total} |`;
	});
	return [
		`### prefix の安定度（会話の軌跡 ${Object.values(prefix.arms)[0]?.calls.length ?? 0} 呼び出し、経路 ${prefix.serialization}）`,
		"",
		"基準7は「token 比の中央値」で比べる。全体比と合計は補足である。",
		"",
		"| arm | token 比の中央値 | byte 比の中央値 | token 全体比 | 共有 token の合計 | 2回目以降の token の合計 |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
	];
}

export function resultsMarkdown(analysis: Analysis, meta: ReportMeta): string {
	const lines = [
		`# context-eval 結果: ${meta.experiment}`,
		"",
		`- lane: \`${analysis.lane}\`、split: \`${analysis.split}\``,
		analysis.binding
			? "- この結果は採否に使える（live の holdout）。"
			: "- **この結果は採否に使えない**（fixture の段階、または holdout 以外）。基盤が動くことの確認である。",
		`- baseline: \`${analysis.baseline}\`、事例 ${analysis.caseCount} 件、試行 ${analysis.expectedTrials} 回、事例の判定は過半数の合格`,
		`- 基準の数値: 正味の改善 ${analysis.thresholds.minNetGain} 件以上、token 比 ${analysis.thresholds.maxTokenRatio} 以下、応答時間の中央値の比 ${analysis.thresholds.maxLatencyRatio} 以下`,
		`- manifest: ${meta.manifestSha256 ?? "なし（freeze 前）"}`,
		`- 採点の元: ${meta.scoredFrom}`,
		`- prefix の計測（run の prefix.json）: ${meta.prefixSha256 ?? "なし"}`,
		`- 生成: ${meta.generatedAt}`,
		"",
		...(analysis.comparisons.length === 0
			? ["候補の arm がないため、比較は行っていない。", ""]
			: analysis.comparisons.flatMap(section)),
		...(meta.prefix ? prefixTable(meta.prefix) : []),
	];
	return `${lines.join("\n")}\n`;
}
