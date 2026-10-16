import { useEffect, useRef, useState } from "react";
import { Camera, Copy, FileUp, Video } from "lucide-react";
import { Button } from "../Button";
import { useCameraCapture } from "../ObjectRecognitionWorkspace/useCameraCapture";
import { stateLabels, type OcrWorkspaceProps } from "./types";
import "./ocr.css";
const errors: Record<string, string> = {
	ocr_busy: "OCRサービスが混雑しています。",
	ocr_invalid_input: "ファイル形式か動画の長さを確認してください。",
	ocr_input_too_large: "16 MiBを超えています。",
	ocr_auth_failed: "backendの認証設定を確認してください。",
	ocr_connection_failed: "OCRサービスに接続できませんでした。",
	ocr_connection_changed: "接続先が変更されました。",
	ocr_submission_unconfirmed:
		"受付を確認できませんでした。自動再送はしていません。",
	ocr_cancel_unconfirmed: "取消の完了を確認できませんでした。",
};
const correctionLabels = {
	queued: "待機中",
	running: "補正中",
	cancelling: "取消中",
	cancelled: "取消済み",
	completed: "完了",
	failed: "失敗",
} as const;
function correctionText(
	result: NonNullable<
		NonNullable<OcrWorkspaceProps["corrections"]>[number]["result"]
	>,
) {
	return result.blocks
		.map((block) => {
			if (block.kind === "paragraph") return block.text;
			const grid = Array.from({ length: block.rows }, () =>
				Array<string>(block.columns).fill(""),
			);
			for (const cell of block.cells) grid[cell.row]![cell.column] = cell.text;
			return grid.map((row) => row.join("\t")).join("\n");
		})
		.join("\n\n");
}
export function OcrPanel(props: OcrWorkspaceProps) {
	const input = useRef<HTMLInputElement>(null);
	const [localError, setLocalError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [endpoint, setEndpoint] = useState(props.baseUrl ?? "");
	async function upload(file: File) {
		setLocalError("");
		setSubmitting(true);
		try {
			await props.onFile?.(file);
		} catch {
			setLocalError(
				"送信できませんでした。接続状態・形式・容量を確認してください。",
			);
		} finally {
			setSubmitting(false);
		}
	}
	const { preview, ...camera } = useCameraCapture(upload);
	useEffect(() => {
		props.onRecordingChange?.(camera.recording);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- runs only when the listed value changes
	}, [camera.recording]);
	useEffect(() => {
		camera.close();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- runs only when the listed value changes
	}, [props.selectedId]);
	const item = props.items.find((i) => i.id === props.selectedId);
	const frame =
		item?.result?.kind === "video"
			? item.result.frames[props.frameIndex]
			: undefined;
	const text =
		item?.result?.kind === "image" ? item.result.text : (frame?.text ?? "");
	const lines =
		item?.result?.kind === "image" ? item.result.lines : (frame?.lines ?? []);
	const selectedText = props.selectedLines
		.map((i) => lines[i]?.text ?? "")
		.join("\n");
	const active =
		item &&
		["queued", "starting", "running", "cancelling"].includes(item.state);
	const correction =
		props.corrections?.find((c) => c.id === props.correctionSelectedId) ??
		props.corrections?.[0];
	const preferred = props.corrections?.find(
		(c) =>
			c.id === props.correctionPreferredId &&
			c.state === "completed" &&
			c.result,
	);
	const displayText = preferred?.result
		? correctionText(preferred.result)
		: text;
	const correcting = props.corrections?.find((c) =>
		["queued", "running", "cancelling"].includes(c.state),
	);
	return (
		<section className="ocr-panel" aria-label="OCR結果と入力">
			{!props.configured && (
				<div className="ocr-connection">
					<p>
						OCRの接続先が未設定です。backendから到達できるgateway
						URLを保存してください。認証はLARM共通トークンを使います。
					</p>
					<label>
						接続先 URL
						<input
							value={endpoint}
							onChange={(e) => setEndpoint(e.target.value)}
							placeholder="http://127.0.0.1:18794/"
						/>
					</label>
					<Button
						onClick={() => props.onConfigure?.(endpoint)}
						disabled={!endpoint || props.busy}
					>
						保存
					</Button>
				</div>
			)}
			<div className="ocr-controls" aria-label="画像・動画の入力">
				<Button
					variant="secondary"
					size="icon"
					aria-label="画像・動画ファイルをアップロード"
					title="画像・動画ファイルをアップロード"
					disabled={
						!props.configured || props.busy || submitting || camera.recording
					}
					onClick={() => input.current?.click()}
				>
					<FileUp size={18} />
				</Button>
				<input
					ref={input}
					className="ocr-file-input"
					type="file"
					accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
					tabIndex={-1}
					aria-hidden="true"
					onChange={(e) => {
						const file = e.currentTarget.files?.[0];
						e.currentTarget.value = "";
						if (file) void upload(file);
					}}
				/>
				<Button
					variant="secondary"
					size="icon"
					aria-label="カメラを開く"
					title="カメラを開く"
					disabled={!props.configured || props.busy || camera.opened}
					onClick={() => void camera.open()}
				>
					<Camera size={18} />
				</Button>
				{camera.opened && (
					<>
						<Button
							size="sm"
							disabled={camera.recording || submitting}
							onClick={() => void camera.photo()}
						>
							撮影
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={submitting || props.busy}
							onClick={() =>
								camera.recording ? camera.finishRecording() : camera.record()
							}
						>
							<Video size={16} />
							{camera.recording ? "録画を終了" : "録画"}
						</Button>
						<Button variant="ghost" size="sm" onClick={camera.close}>
							カメラを閉じる
						</Button>
					</>
				)}
				<small>
					JPEG・PNG・WebP / MP4・MOV・WebM、16 MiBまで。動画30秒まで。
				</small>
			</div>
			<video
				ref={preview}
				autoPlay
				muted
				playsInline
				hidden={!camera.opened}
				className="ocr-camera"
				aria-label="カメラプレビュー"
			/>
			{(props.error || localError || camera.error) && (
				<p role="alert" className="ocr-message">
					{props.error || localError || camera.error}
				</p>
			)}
			{props.message && (
				<p role="status" className="ocr-message">
					{props.message}
				</p>
			)}
			{item && (
				<div className="ocr-status" role="status">
					<strong>{item.name}</strong>
					<span>{stateLabels[item.state]}</span>
					{item.errorCode && (
						<p>{errors[item.errorCode] ?? "処理に失敗しました。"}</p>
					)}
					{active && item.state !== "cancelling" && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => props.onCancel?.(item.id)}
						>
							中止
						</Button>
					)}
					{item.canRecheck && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => props.onRecheck?.(item.id)}
						>
							状態を再確認
						</Button>
					)}
				</div>
			)}
			{item?.state === "completed" && (
				<>
					<div className="ocr-result-heading">
						<h3>{preferred ? "採用中の補正案" : "読み取った原文"}</h3>
						<Button
							size="sm"
							variant="secondary"
							disabled={!displayText}
							onClick={() => props.onCopy?.(displayText)}
						>
							<Copy size={15} />
							表示中の全文をコピー
						</Button>
					</div>
					<p className="ocr-confidence-note">
						confidence は参考値です。元資料と照らして確認してください。
					</p>
					<pre className="ocr-raw-text">
						{displayText || "（文字は検出されませんでした）"}
					</pre>
					{preferred && (
						<>
							<h4>OCR原文</h4>
							<pre className="ocr-raw-text">
								{text || "（文字は検出されませんでした）"}
							</pre>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => props.onCopy?.(text)}
							>
								原文をコピー
							</Button>
						</>
					)}
					<div className="ocr-lines" role="group" aria-label="読み取った行">
						{lines.map((line, index) => (
							<label
								key={index}
								className={
									props.selectedLines.includes(index) ? "selected" : ""
								}
							>
								<input
									type="checkbox"
									checked={props.selectedLines.includes(index)}
									onChange={() => props.onLine?.(index)}
								/>
								<span>{line.text || "（空行）"}</span>
								<small>{line.confidence.toFixed(2)}</small>
							</label>
						))}
					</div>
					<div className="ocr-result-actions">
						<Button
							size="sm"
							variant="secondary"
							disabled={!props.selectedLines.length}
							onClick={() => props.onCopy?.(selectedText)}
						>
							選択箇所をコピー
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!props.selectedLines.length}
							onClick={() =>
								props.onIncorporate?.(
									item.id,
									item.result?.kind === "video" ? props.frameIndex : undefined,
									props.selectedLines,
								)
							}
						>
							選択箇所を会話に追加
						</Button>
						<Button
							size="sm"
							onClick={() =>
								props.onIncorporate?.(
									item.id,
									item.result?.kind === "video" ? props.frameIndex : undefined,
								)
							}
						>
							原文を会話に追加
						</Button>
					</div>
					<section className="ocr-correction" aria-label="LLM補正案">
						<div className="ocr-result-heading">
							<h3>LLM補正案</h3>
							<Button
								size="sm"
								disabled={!!correcting || props.correctionLoading}
								onClick={() => props.onCorrectionStart?.(item.id)}
							>
								補正案を作る
							</Button>
						</div>
						<p className="ocr-confidence-note">
							元画像とOCR原文をLLMへ渡します。案は原文を変更せず、確認してから採用できます。
						</p>
						{correcting && (
							<div role="status">
								{correctionLabels[correcting.state]}{" "}
								<Button
									variant="secondary"
									size="sm"
									disabled={correcting.state === "cancelling"}
									onClick={() =>
										props.onCorrectionCancel?.(item.id, correcting.id)
									}
								>
									補正を中止
								</Button>
							</div>
						)}
						{!!props.corrections?.length && (
							<div
								className="ocr-correction-history"
								role="group"
								aria-label="補正案の履歴"
							>
								{props.corrections.map((c) => (
									<Button
										key={c.id}
										size="sm"
										variant={c.id === correction?.id ? "default" : "secondary"}
										onClick={() => props.onCorrectionSelect?.(item.id, c.id)}
									>
										{new Date(c.createdAt).toLocaleString("ja-JP")}・
										{correctionLabels[c.state]}
										{c.id === props.correctionPreferredId ? "・採用中" : ""}
									</Button>
								))}
								{props.correctionHasMore && (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => props.onCorrectionMore?.(item.id)}
									>
										さらに表示
									</Button>
								)}
							</div>
						)}
						{correction?.state === "failed" && (
							<p role="alert">
								補正に失敗しました。原文を確認し、必要なら別の案を作ってください。
								{correction.errorCode ? `（${correction.errorCode}）` : ""}
							</p>
						)}
						{correction?.state === "completed" && correction.result && (
							<>
								<div className="ocr-correction-blocks">
									{correction.result.blocks.map((block, index) =>
										block.kind === "paragraph" ? (
											<p
												key={index}
												className={block.uncertain ? "uncertain" : ""}
											>
												{block.text}
												{block.uncertain && (
													<small> 判読困難: {block.uncertainty}</small>
												)}
												{(block.evidence.lineIndexes.length > 0 ||
													block.evidence.region) && (
													<button
														type="button"
														className="ocr-correction-evidence"
														onClick={() =>
															props.onCorrectionEvidence?.(
																item.id,
																correction.id,
																index,
															)
														}
													>
														元画像の根拠を見る
													</button>
												)}
											</p>
										) : (
											<div
												key={index}
												className={
													block.uncertain
														? "ocr-correction-table uncertain"
														: "ocr-correction-table"
												}
											>
												{block.uncertain && (
													<p>判読困難: {block.uncertainty}</p>
												)}
												<table>
													<tbody>
														{Array.from({ length: block.rows }, (_, row) => (
															<tr key={row}>
																{block.cells
																	.filter((cell) => cell.row === row)
																	.sort((a, b) => a.column - b.column)
																	.map((cell, j) => (
																		<td
																			key={`${cell.column}-${j}`}
																			rowSpan={cell.rowSpan}
																			colSpan={cell.columnSpan}
																			className={
																				cell.uncertain ? "uncertain" : undefined
																			}
																		>
																			{cell.text}
																			{cell.uncertain && (
																				<small>
																					{" "}
																					判読困難: {cell.uncertainty}
																				</small>
																			)}
																			{(cell.evidence.lineIndexes.length > 0 ||
																				cell.evidence.region) && (
																				<button
																					type="button"
																					className="ocr-correction-evidence"
																					onClick={() =>
																						props.onCorrectionEvidence?.(
																							item.id,
																							correction.id,
																							index,
																							cell.row,
																							cell.column,
																						)
																					}
																				>
																					根拠を見る
																				</button>
																			)}
																		</td>
																	))}
															</tr>
														))}
													</tbody>
												</table>
											</div>
										),
									)}
									{correction.result.excludedLines.length > 0 && (
										<div className="ocr-correction-exclusions">
											<strong>補正案から除外したOCR行</strong>
											<ul>
												{correction.result.excludedLines.map((entry) => (
													<li key={entry.index}>
														{entry.index + 1}行目: {entry.reason}
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
								<div className="ocr-result-actions">
									<Button
										size="sm"
										variant="secondary"
										onClick={() =>
											props.onCopy?.(correctionText(correction.result!))
										}
									>
										補正案をコピー
									</Button>
									<Button
										size="sm"
										variant="secondary"
										onClick={() =>
											props.onCorrectionIncorporate?.(item.id, correction.id)
										}
									>
										補正案を会話に追加
									</Button>
									{correction.id === props.correctionPreferredId ? (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => props.onCorrectionOriginal?.(item.id)}
										>
											原文を既定に戻す
										</Button>
									) : (
										<Button
											size="sm"
											onClick={() =>
												props.onCorrectionPrefer?.(item.id, correction.id)
											}
										>
											この案を採用
										</Button>
									)}
								</div>
							</>
						)}
					</section>
				</>
			)}
		</section>
	);
}
