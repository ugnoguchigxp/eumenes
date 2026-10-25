import { Copy, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "../Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { OcrQr } from "./OcrQr";
import { ocrLinesInRegion } from "./region";
import { correctionText, OcrCorrection } from "./OcrCorrection";
import type { OcrRecord, OcrWorkspaceProps } from "./types";

/** Presentation only: raw lines, explicit correction preference and actions come from the shared resource. */
export function OcrResult(props: OcrWorkspaceProps & { item: OcrRecord }) {
	const { item } = props;
	const frame =
		item.result?.kind === "video"
			? item.result.frames[props.frameIndex]
			: undefined;
	const text =
		item.result?.kind === "image" ? item.result.text : (frame?.text ?? "");
	const lines =
		item.result?.kind === "image" ? item.result.lines : (frame?.lines ?? []);
	const visibleIndexes = props.selectionRegion
		? ocrLinesInRegion(lines, props.selectionRegion)
		: lines.map((_, i) => i);
	const selectedText = props.selectedLines
		.map((i) => lines[i]?.text ?? "")
		.join("\n");
	const preferred = props.corrections?.find(
		(c) =>
			c.id === props.correctionPreferredId &&
			c.state === "completed" &&
			c.result,
	);
	const displayText = props.selectionRegion
		? visibleIndexes.map((i) => lines[i]!.text).join("\n")
		: preferred?.result
			? correctionText(preferred.result)
			: text;
	const frameIndex =
		item.result?.kind === "video" ? props.frameIndex : undefined;
	const correcting = props.corrections?.some((correction) =>
		["queued", "running", "cancelling"].includes(correction.state),
	);
	return (
		<div className="ocr-result">
			<div className="ocr-result-heading">
				<h3>
					{props.selectionRegion
						? `範囲内のOCR原文（${visibleIndexes.length}行）`
						: preferred
							? "採用中の補正案"
							: "読み取った原文"}
				</h3>
			</div>
			<div
				className="ocr-result-toolbar"
				role="group"
				aria-label="読み取り結果の操作"
			>
				<Button
					disabled={correcting || props.correctionLoading}
					onClick={() => props.onCorrectionStart?.(item.id)}
				>
					<Sparkles size={17} />{" "}
					{props.selectionRegion ? "全文の補正案を作る" : "読み取り結果を補正"}
				</Button>
				<Button
					variant="outline"
					aria-label={
						props.selectionRegion ? "範囲内をコピー" : "表示中の全文をコピー"
					}
					disabled={!displayText}
					onClick={() => props.onCopy?.(displayText)}
				>
					<Copy size={15} />{" "}
					{props.selectionRegion ? "範囲内をコピー" : "全文をコピー"}
				</Button>
			</div>
			<Tabs
				key={props.selectionRegion ? "region" : "all"}
				defaultValue={props.selectionRegion || preferred ? "text" : "lines"}
				className="ocr-result-tabs"
			>
				<TabsList aria-label="結果の表示">
					<TabsTrigger value="text">全文</TabsTrigger>
					<TabsTrigger value="lines">行ごと</TabsTrigger>
				</TabsList>
				<TabsContent value="text">
					<pre className="ocr-raw-text">
						{displayText ||
							(props.selectionRegion
								? "該当する行がありません"
								: "（文字は検出されませんでした）")}
					</pre>
					{preferred && !props.selectionRegion && (
						<div className="ocr-original-comparison">
							<h4>OCR原文</h4>
							<pre className="ocr-raw-text">
								{text || "（文字は検出されませんでした）"}
							</pre>
							<Button
								size="sm"
								variant="outline"
								onClick={() => props.onCopy?.(text)}
							>
								原文をコピー
							</Button>
						</div>
					)}
				</TabsContent>
				<TabsContent value="lines">
					{preferred && !props.selectionRegion && (
						<p className="ocr-confidence-note">
							行ごとにはOCR原文と元資料の位置を表示しています。
						</p>
					)}
					<div className="ocr-lines" role="group" aria-label="読み取った行">
						{visibleIndexes.map((index) => {
							const line = lines[index]!;
							return (
								<label
									key={index}
									className={
										props.selectedLines.includes(index) ? "selected" : ""
									}
								>
									<input
										type="checkbox"
										aria-label={`${index + 1}行目: ${line.text || "空行"}`}
										checked={props.selectedLines.includes(index)}
										onChange={() => props.onLine?.(index)}
									/>
									<span className="ocr-line-number" aria-hidden="true">
										{String(index + 1).padStart(2, "0")}
									</span>
									<span className="ocr-line-text">
										{line.text || "（空行）"}
									</span>
									<small title="confidence（参考値）">
										{line.confidence.toFixed(2)}
									</small>
								</label>
							);
						})}
						{!visibleIndexes.length && (
							<p className="ocr-empty-note">選択できる行はありません。</p>
						)}
					</div>
				</TabsContent>
			</Tabs>
			<p className="ocr-confidence-note">
				confidenceは参考値です。元資料と照らして確認してください。
			</p>
			<div
				className="ocr-selection-actions"
				role="group"
				aria-label="選択箇所の操作"
			>
				<span role="status">
					{props.selectedLines.length
						? `${props.selectedLines.length}行を選択中`
						: "行を選んで操作"}
				</span>
				<Button
					size="sm"
					variant="outline"
					aria-label="選択箇所をコピー"
					disabled={!props.selectedLines.length}
					onClick={() => props.onCopy?.(selectedText)}
				>
					選択行をコピー
				</Button>
				<Button
					size="sm"
					variant="outline"
					aria-label="選択箇所を会話に追加"
					disabled={!props.selectedLines.length}
					onClick={() =>
						props.onIncorporate?.(item.id, frameIndex, props.selectedLines)
					}
				>
					会話に追加
				</Button>
			</div>
			<Button
				className="ocr-incorporate"
				disabled={!!props.selectionRegion && visibleIndexes.length === 0}
				onClick={() =>
					props.selectionRegion
						? props.onIncorporate?.(item.id, frameIndex, visibleIndexes)
						: props.onIncorporate?.(item.id, frameIndex)
				}
			>
				<MessageSquarePlus size={17} />{" "}
				{props.selectionRegion
					? "範囲内の原文を会話に追加"
					: "原文を会話に追加"}
			</Button>
			<OcrCorrection {...props} itemId={item.id} />
			<OcrQr {...props} itemId={item.id} />
		</div>
	);
}
