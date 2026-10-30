import { useId, useState } from "react";
import { Button } from "../Button";
import type { VisualAnalysisProps, VisualAnalysisTask } from "./types";
import "./visual-analysis.css";
import { StopObservationStatus } from "./StopObservationStatus";
const tasks: Record<VisualAnalysisTask, string> = {
	describe: "画像を説明",
	referring: "条件に合う物を探す",
	detection: "種類で検出",
	count_box: "箱で数える",
	segmentation: "対象を切り抜く",
	matting: "輪郭を滑らかに切り抜く",
	ocr: "文字を読む",
	ocr_grounding: "指定した文字を探す",
};
const states = {
	queued: "受付済み",
	starting: "起動中",
	running: "解析中",
	completed: "完了",
	failed: "失敗",
	cancelling: "中止処理中",
	cancelled: "中止済み",
};
const errors: Record<string, string> = {
	analysis_image_too_large:
		"詳細分析の画像上限を超えています。4 MiB・約419万画素・各辺8192px以内の画像を使ってください。",
	analysis_unconfigured: "LARMの接続設定を確認してください。",
	analysis_provider_unavailable: "LARMで詳細分析サービスが見つかりません。",
	analysis_connection_changed: "接続設定が変更されました。",
	analysis_source_changed: "元資料が変更されました。",
	analysis_timeout: "解析の待機時間を超えました。",
	analysis_interrupted:
		"解析が中断されました。受付不明の推論は再送していません。",
	invalid_visual_response:
		"解析サービスの応答形式が正しくありません。LARM側の対応状況を確認してください。",
	larm_http_400: "分析条件を確認してください。",
	larm_http_413: "画像または出力が上限を超えました。",
	larm_http_401: "接続の資格が無効です。改めて分析を実行してください。",
	larm_http_409: "接続が競合しています。",
	larm_http_429: "解析サービスを他の処理が使用しています。",
	larm_http_503: "解析サービスを利用できません。",
	larm_http_504: "解析サービスの待機時間を超えました。",
	invalid_larm_audience: "保存済みのLARM接続方式では詳細分析を利用できません。",
};
const decoderLabel = (value: string | null) =>
	value === null ? "decoder非搭載" : value;
export function VisualAnalysis(props: VisualAnalysisProps) {
	const id = useId().replace(/:/g, "");
	const [task, setTask] = useState<VisualAnalysisTask>("describe");
	const [query, setQuery] = useState(
		"この画像で何が起きているか説明してください。",
	);
	const [categories, setCategories] = useState<string[]>([]);
	const [selected, setSelected] = useState<number>();
	const [masks, setMasks] = useState(true);
	const analysis = props.analysis,
		result = analysis?.result;
	const active =
		!!analysis &&
		["queued", "starting", "running", "cancelling"].includes(analysis.state);
	return (
		<section className="visual-analysis" aria-label="詳細分析">
			<Button
				variant="outline"
				disabled={!props.analysisAvailable || props.analysisPending}
				onClick={props.onAnalysisOpen}
			>
				詳細分析
			</Button>
			<small>
				選択した画像全体を分析します。起動と解析に数十秒かかる場合があります。
			</small>
			{props.analysisOpen && (
				<div className="visual-analysis-panel">
					<h3>詳細分析結果</h3>
					{props.analysisError && <p role="alert">{props.analysisError}</p>}
					{(props.analysisRecords?.length ?? 0) > 1 && (
						<label>
							分析の履歴
							<select
								aria-label="分析の履歴"
								value={analysis?.id ?? ""}
								onChange={(e) => props.onAnalysisSelect?.(e.target.value)}
							>
								{props.analysisRecords!.map((r) => (
									<option key={r.id} value={r.id}>
										{tasks[r.options.task]} ·{" "}
										{new Date(r.createdAt).toLocaleTimeString("ja-JP")} ·{" "}
										{states[r.state]}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="visual-analysis-form">
						<label>
							分析の用途
							<select
								value={task}
								onChange={(e) => setTask(e.target.value as VisualAnalysisTask)}
							>
								{Object.entries(tasks).map(([v, label]) => (
									<option key={v} value={v}>
										{label}
									</option>
								))}
							</select>
						</label>
						<label>
							調べたい内容
							<textarea
								value={query}
								maxLength={2048}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={
									task === "ocr"
										? "空欄でも文字を読み取れます"
										: "対象や説明してほしい観点"
								}
							/>
						</label>
						{task === "detection" && (
							<fieldset>
								<legend>複数の種類を指定する場合</legend>
								{categories.map((v, i) => (
									<label key={i}>
										種類 {i + 1}
										<input
											maxLength={128}
											value={v}
											onChange={(e) =>
												setCategories((prev) =>
													prev.map((x, n) => (n === i ? e.target.value : x)),
												)
											}
										/>
										<button
											type="button"
											onClick={() =>
												setCategories((prev) => prev.filter((_, n) => n !== i))
											}
										>
											削除
										</button>
									</label>
								))}
								<Button
									size="sm"
									variant="outline"
									disabled={categories.length >= 32}
									onClick={() => setCategories((prev) => [...prev, ""])}
								>
									種類を追加
								</Button>
							</fieldset>
						)}
						<div className="visual-analysis-actions">
							<Button
								disabled={
									props.analysisPending ||
									active ||
									(!query.trim() &&
										task !== "ocr" &&
										!(task === "detection" && categories.length)) ||
									categories.some((v) => task === "detection" && !v.trim())
								}
								onClick={() =>
									props.onAnalysisRun?.({
										task,
										query:
											task === "detection" && categories.length
												? categories
												: query,
									})
								}
							>
								分析する
							</Button>
							{active && (
								<Button
									variant="secondary"
									disabled={analysis.state === "cancelling"}
									onClick={props.onAnalysisCancel}
								>
									中止
								</Button>
							)}
						</div>
					</div>
					{analysis && (
						<p role="status">
							{analysis.state === "cancelled" &&
							analysis.releaseConfirmed === null
								? "中止処理中（結果は採用しません）"
								: states[analysis.state]}
						</p>
					)}
					{analysis?.errorCode && (
						<p role="alert">
							{errors[analysis.errorCode] ??
								"詳細分析に失敗しました。条件と接続を確認してください。"}
						</p>
					)}
					{analysis?.releaseConfirmed === false && (
						<p role="alert">解析用接続の解放を確認できませんでした。</p>
					)}
					<StopObservationStatus observation={analysis?.stopObservation} />
					{result && (
						<>
							{result.truncated && (
								<p role="alert">生成上限に達したため結果は途中までです。</p>
							)}
							{props.analysisImageUrl && (
								<svg
									className="visual-analysis-image"
									viewBox={`0 0 ${result.image.width} ${result.image.height}`}
									role="img"
									aria-label="詳細分析の対象画像と検出枠"
								>
									<image
										href={props.analysisImageUrl}
										width={result.image.width}
										height={result.image.height}
									/>
									<defs>
										{result.masks.map((_, i) => (
											<mask
												key={i}
												id={`${id}-mask-${i}`}
												maskUnits="userSpaceOnUse"
												x="0"
												y="0"
												width={result.image.width}
												height={result.image.height}
												style={{ maskType: "luminance" }}
											>
												<image
													href={props.analysisMaskUrls?.[i]}
													width={result.image.width}
													height={result.image.height}
												/>
											</mask>
										))}
									</defs>
									{masks &&
										result.masks.map((m, i) =>
											(selected === undefined ||
												selected === m.detectionIndex) &&
											props.analysisMaskUrls?.[i] ? (
												<rect
													key={i}
													width={result.image.width}
													height={result.image.height}
													fill="#03b6b8"
													fillOpacity=".5"
													mask={`url(#${id}-mask-${i})`}
												/>
											) : null,
										)}
									{result.detections.map((d, i) => (
										<rect
											key={i}
											x={d.box[0]}
											y={d.box[1]}
											width={d.box[2] - d.box[0]}
											height={d.box[3] - d.box[1]}
											fill="none"
											stroke={selected === i ? "#f09b20" : "#087f8c"}
											strokeWidth={Math.max(2, result.image.width / 300)}
										>
											<title>{d.label}</title>
										</rect>
									))}
								</svg>
							)}
							{result.masks.length > 0 && (
								<label>
									<input
										type="checkbox"
										checked={masks}
										onChange={(e) => setMasks(e.target.checked)}
									/>
									マスクを重ねる
								</label>
							)}
							<p className="visual-analysis-text">{result.response}</p>
							{result.count !== undefined && (
								<p>
									検出した箱の数: {result.count}
									（実際の物体数を保証するものではありません）
								</p>
							)}
							{result.detections.length > 0 ? (
								<ul>
									{result.detections.map((d, i) => (
										<li key={i}>
											<button
												type="button"
												aria-pressed={selected === i}
												onClick={() =>
													setSelected(selected === i ? undefined : i)
												}
											>
												{i + 1}. {d.label}
												{d.text ? ` · ${d.text}` : ""}
											</button>
										</li>
									))}
								</ul>
							) : (
								result.task !== "describe" && (
									<p>条件に合う対象は検出されませんでした。</p>
								)
							)}
							<p className="visual-analysis-timing">
								起動待ち {Math.round(analysis?.waitingMs ?? 0)} ms · 推論待ち{" "}
								{Math.round(analysis?.inferenceMs ?? 0)} ms · 全体{" "}
								{Math.round(analysis?.elapsedMs ?? 0)} ms · モデル内処理{" "}
								{result.timings.totalMs} ms
							</p>
							<details>
								<summary>実行情報</summary>
								<p>
									{result.model} · {result.modelRevision}
								</p>
								<p>
									{result.execution.device} / {result.execution.backend} /{" "}
									{result.execution.dtype} /{" "}
									{decoderLabel(result.execution.decoderDtype)}
								</p>
								<p>
									出力 {result.execution.outputTokens} tokens · 画像{" "}
									{result.execution.visualTokens} tokens
								</p>
							</details>
						</>
					)}
					<small>
						分析結果は履歴に保存します。LARM側の監査方針も適用されます。
					</small>
				</div>
			)}
		</section>
	);
}
