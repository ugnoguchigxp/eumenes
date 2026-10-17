import { Button } from "../Button";
import { Sparkles } from "lucide-react";
import type { OcrWorkspaceProps } from "./types";

const correctionLabels = {
	queued: "待機中",
	running: "補正中",
	cancelling: "取消中",
	cancelled: "取消済み",
	completed: "完了",
	failed: "失敗",
} as const;
export function correctionText(
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
/** LLM correction proposals for one completed OCR item. */
export function OcrCorrection({
	itemId,
	...props
}: OcrWorkspaceProps & { itemId: string }) {
	const correction =
		props.corrections?.find((c) => c.id === props.correctionSelectedId) ??
		props.corrections?.[0];
	const correcting = props.corrections?.find((c) =>
		["queued", "running", "cancelling"].includes(c.state),
	);
	return (
		<section className="ocr-correction" aria-label="LLM補正案">
			<div className="ocr-result-heading">
				<h3>
					<Sparkles size={17} /> 補正案
				</h3>
				<Button
					size="sm"
					variant="outline"
					disabled={!!correcting || props.correctionLoading}
					onClick={() => props.onCorrectionStart?.(itemId)}
				>
					補正案を作る
				</Button>
			</div>
			<p className="ocr-confidence-note">
				元画像と原文をAIに渡して補正案を作ります。原文を残したまま、確認して採用できます。
			</p>
			{correcting && (
				<div role="status">
					{correctionLabels[correcting.state]}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={correcting.state === "cancelling"}
						onClick={() => props.onCorrectionCancel?.(itemId, correcting.id)}
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
							onClick={() => props.onCorrectionSelect?.(itemId, c.id)}
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
							onClick={() => props.onCorrectionMore?.(itemId)}
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
								<p key={index} className={block.uncertain ? "uncertain" : ""}>
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
													itemId,
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
									{block.uncertain && <p>判読困難: {block.uncertainty}</p>}
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
																	<small> 判読困難: {cell.uncertainty}</small>
																)}
																{(cell.evidence.lineIndexes.length > 0 ||
																	cell.evidence.region) && (
																	<button
																		type="button"
																		className="ocr-correction-evidence"
																		onClick={() =>
																			props.onCorrectionEvidence?.(
																				itemId,
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
							onClick={() => props.onCopy?.(correctionText(correction.result!))}
						>
							補正案をコピー
						</Button>
						<Button
							size="sm"
							variant="secondary"
							onClick={() =>
								props.onCorrectionIncorporate?.(itemId, correction.id)
							}
						>
							補正案を会話に追加
						</Button>
						{correction.id === props.correctionPreferredId ? (
							<Button
								size="sm"
								variant="secondary"
								onClick={() => props.onCorrectionOriginal?.(itemId)}
							>
								原文を既定に戻す
							</Button>
						) : (
							<Button
								size="sm"
								onClick={() =>
									props.onCorrectionPrefer?.(itemId, correction.id)
								}
							>
								この案を採用
							</Button>
						)}
					</div>
				</>
			)}
		</section>
	);
}
