/** RESULTS-ready output of an analysis: a JSON document and a Markdown table. */
import type { Analysis, Comparison } from "./analysis";
import type { PrefixReport } from "./prefix-measure";

export type ReportMeta = {
	experiment: string;
	generatedAt: string;
	/** sha256 of manifest.json when the experiment was frozen, else null. */
	manifestSha256: string | null;
	scoredFrom: string;
	/** The earlier run this one is compared with (its scores directory), or null. */
	baselineFrom: string | null;
	/** sha256 of the run's prefix.json (the trajectory measurement criterion 6 reads), or null when the run has none. */
	prefixSha256: string | null;
	prefix: PrefixReport | null;
};

export function resultsJson(analysis: Analysis, meta: ReportMeta) {
	return {
		format: "context-eval.results",
		version: 2,
		...meta,
		lane: analysis.lane,
		split: analysis.split,
		binding: analysis.binding,
		thresholds: analysis.thresholds,
		expectedTrials: analysis.expectedTrials,
		caseCount: analysis.caseCount,
		run: analysis.run,
		comparison: analysis.comparison,
	};
}

const mark = { pass: "合格", fail: "不合格", not_measured: "未計測" } as const;
const decisionText = {
	adopt: "採用",
	reject: "不採用",
	incomplete: "判定不能（incomplete）",
	not_binding: "判定しない（採否に使えない）",
} as const;

function runSection(run: Analysis["run"]): string[] {
	const families = Object.entries(run.perFamily).map(
		([family, d]) =>
			`| ${family} | ${d.cases} | ${d.passed} | ${d.failed} | ${d.incomplete} |`,
	);
	return [
		"### この run の結果",
		"",
		"| 族 | 事例 | 合格 | 不合格 | 判定不能 |",
		"| --- | --- | --- | --- | --- |",
		...families,
		"",
		`- 安全族（F5・F6・F10）で合格していない事例: ${run.safetyFailures.join(", ") || "なし"}`,
		`- F9 の発話契約違反の試行: ${run.f9Violations}`,
		`- 送信 token の推定の合計: ${run.tokens}、応答時間の中央値: ${run.medianLatencyMs === null ? "n/a" : `${Math.round(run.medianLatencyMs)} ms`}`,
		`- 普段の生成の prefix の安定度（token 比の中央値）: ${run.prefixMedianRatio?.toFixed(3) ?? "n/a"}`,
		`- 通信エラー ${run.transportErrors}、判定待ち ${run.needsAdjudication}`,
		"",
	];
}

function comparisonSection(c: Comparison): string[] {
	const families = Object.entries(c.perFamily)
		.map(
			([family, d]) =>
				`${family}: +${d.improved} / -${d.regressed} (正味 ${d.net})`,
		)
		.join("、");
	return [
		"### baseline との比較",
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

/** The trajectory measurements as tables: one row per trajectory, then the calls of each. */
function prefixTables(prefix: PrefixReport): string[] {
	const rows = Object.entries(prefix.trajectories).map(([name, report]) => {
		const rebuilt = report.calls.filter((c) => c.cut !== null).length;
		return `| ${name} | ${report.calls.length} | ${rebuilt} | ${report.medianRatio?.toFixed(3) ?? "n/a"} | ${report.medianByteRatio?.toFixed(3) ?? "n/a"} | ${report.aggregateRatio?.toFixed(3) ?? "n/a"} |`;
	});
	return [
		"### prefix の安定度（会話の軌跡）",
		"",
		"基準6は「普段の生成（再構成の直後でない呼び出し）の token 比の中央値」で比べる。全体比は補足である。",
		"",
		"| 軌跡 | 呼び出し | 再構成 | token 比の中央値 | byte 比の中央値 | token 全体比 |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
		...Object.entries(prefix.trajectories).flatMap(([name, report]) => [
			`#### ${name}`,
			"",
			"| 呼び出し | token | 先頭の共有 token | 比 | 再構成の理由 |",
			"| --- | --- | --- | --- | --- |",
			...report.calls.map(
				(c) =>
					`| ${c.label} | ${c.tokens} | ${c.sharedTokens ?? "-"} | ${c.tokenRatio?.toFixed(3) ?? "-"} | ${c.cut ?? "-"} |`,
			),
			"",
		]),
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
		`- 事例 ${analysis.caseCount} 件、試行 ${analysis.expectedTrials} 回、事例の判定は過半数の合格`,
		`- 基準の数値: 正味の改善 ${analysis.thresholds.minNetGain} 件以上、応答時間の中央値の比 ${analysis.thresholds.maxLatencyRatio} 以下`,
		`- manifest: ${meta.manifestSha256 ?? "なし（freeze 前）"}`,
		`- 採点の元: ${meta.scoredFrom}`,
		`- baseline（変更前の run の採点）: ${meta.baselineFrom ?? "なし"}`,
		`- prefix の計測（run の prefix.json）: ${meta.prefixSha256 ?? "なし"}`,
		`- 生成: ${meta.generatedAt}`,
		"",
		...runSection(analysis.run),
		...(analysis.comparison
			? comparisonSection(analysis.comparison)
			: ["baseline の採点がないため、比較は行っていない。", ""]),
		...(meta.prefix ? prefixTables(meta.prefix) : []),
	];
	return `${lines.join("\n")}\n`;
}
