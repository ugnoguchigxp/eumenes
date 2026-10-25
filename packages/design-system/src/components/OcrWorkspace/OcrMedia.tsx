import { useEffect, useRef, useState } from "react";
import {
	Image as ImageIcon,
	Menu,
	RefreshCw,
	ScanText,
	Trash2,
	Video,
	X,
} from "lucide-react";
import { OcrPreview } from "./OcrPreview";
import { Button } from "../Button";
import { menuKeyDown } from "../../utils/menuKeyboard";
import { canRemove, stateLabels, type OcrWorkspaceProps } from "./types";
import "./ocr.css";
function HistoryThumbnail({
	id,
	mime,
	url,
	onNeeded,
}: {
	id: string;
	mime: string;
	url?: string;
	onNeeded?: (id: string) => void;
}) {
	const target = useRef<HTMLSpanElement>(null);
	const requested = useRef(false);
	useEffect(() => {
		if (url || requested.current || !onNeeded || !target.current) return;
		const request = () => {
			requested.current = true;
			onNeeded(id);
		};
		if (typeof IntersectionObserver === "undefined") {
			request();
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				request();
				observer.disconnect();
			}
		});
		observer.observe(target.current);
		return () => observer.disconnect();
	}, [id, onNeeded, url]);
	return (
		<span ref={target} className="ocr-history-thumbnail">
			{url ? (
				<img src={url} alt="" />
			) : mime.startsWith("video/") ? (
				<Video size={20} />
			) : (
				<ImageIcon size={20} />
			)}
		</span>
	);
}
export function OcrMedia(props: OcrWorkspaceProps) {
	const [historyOpen, setHistoryOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<string>();
	const trigger = useRef<HTMLButtonElement>(null);
	const firstItem = useRef<HTMLButtonElement>(null);
	const item = props.items.find((i) => i.id === props.selectedId);
	const width =
		item?.result?.kind === "image"
			? item.result.width
			: item?.result?.video.width;
	const height =
		item?.result?.kind === "image"
			? item.result.height
			: item?.result?.video.height;
	useEffect(() => {
		if (historyOpen) firstItem.current?.focus();
	}, [historyOpen]);
	function closeHistory() {
		setHistoryOpen(false);
		setPendingDelete(undefined);
		trigger.current?.focus();
	}
	return (
		<section className="ocr-media" aria-label="OCRの元資料">
			<h2 className="ocr-workspace-title">
				<ScanText size={20} /> 文字を読み取る
			</h2>
			<header className="ocr-heading">
				<Button
					ref={trigger}
					variant="outline"
					size="sm"
					aria-haspopup="menu"
					aria-expanded={historyOpen}
					disabled={props.recording}
					title={
						props.recording
							? "録画を終了してから資料を選んでください"
							: undefined
					}
					onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
				>
					<Menu size={16} /> 資料一覧
				</Button>
				<div className="ocr-document-info">
					<span className="ocr-document-name" title={item?.name}>
						{item?.name ?? "資料を選択"}
					</span>
					{item && (
						<span className="ocr-state-badge" data-state={item.state}>
							{stateLabels[item.state]}
						</span>
					)}
				</div>
				<Button
					variant="ghost"
					size="icon"
					aria-label="OCRの履歴を更新"
					title="更新"
					onClick={props.onRefresh}
				>
					<RefreshCw size={17} />
				</Button>
			</header>
			{historyOpen && (
				<>
					<button
						className="ocr-history-backdrop"
						aria-label="資料一覧を閉じる"
						onClick={closeHistory}
					/>
					<div
						className="ocr-history"
						role="menu"
						tabIndex={-1}
						aria-label="資料一覧"
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								closeHistory();
							} else menuKeyDown(e);
						}}
					>
						<header>
							<strong>保存した資料</strong>
							<Button
								variant="ghost"
								size="icon"
								aria-label="資料一覧を閉じる"
								onClick={closeHistory}
							>
								<X size={16} />
							</Button>
						</header>
						{props.items.length === 0 && <p>保存した資料はありません。</p>}
						{props.items.map((saved, index) => (
							<div className="ocr-history-entry" key={saved.id}>
								<button
									ref={index === 0 ? firstItem : undefined}
									role="menuitem"
									aria-current={saved.id === item?.id ? "true" : undefined}
									onClick={() => {
										props.onSelect?.(saved.id);
										closeHistory();
									}}
								>
									<HistoryThumbnail
										id={saved.id}
										mime={saved.mime}
										url={props.thumbnails?.[saved.id]}
										onNeeded={props.onThumbnailNeeded}
									/>
									<span className="ocr-history-label">
										<span>{saved.name}</span>
										<small>{stateLabels[saved.state]}</small>
									</span>
								</button>
								<Button
									variant="ghost"
									size="icon"
									aria-label={`${saved.name}を削除`}
									title={
										!canRemove(saved)
											? "解析中は先に取消してください"
											: undefined
									}
									disabled={!canRemove(saved) || props.busy}
									onClick={() => setPendingDelete(saved.id)}
								>
									<Trash2 size={15} />
								</Button>
								{pendingDelete === saved.id && (
									<div
										className="ocr-delete-confirm"
										role="group"
										aria-label="削除確認"
									>
										<p>
											「{saved.name}
											」とOCR結果を削除します。会話に追加した内容からも原本を再表示できなくなります。
										</p>
										<Button
											variant="destructive"
											size="sm"
											onClick={() => {
												props.onRemove?.(saved.id);
												closeHistory();
											}}
										>
											削除する
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setPendingDelete(undefined)}
										>
											やめる
										</Button>
									</div>
								)}
							</div>
						))}
					</div>
				</>
			)}
			<h3 className="ocr-source-heading">元資料</h3>
			{!item ? (
				<div className="ocr-media-empty">
					<ImageIcon size={32} />
					<p>画像・動画の原本をここに表示します。</p>
				</div>
			) : !props.mediaUrl ? (
				<p role="status">原本を読み込んでいます。</p>
			) : width && height && item.state === "completed" ? (
				<OcrPreview
					key={`${item.id}:${item.revision}:${props.frameIndex}`}
					{...props}
					item={item}
					width={width}
					height={height}
				/>
			) : (
				<div className="ocr-preview">
					{item.mime.startsWith("image/") ? (
						<img src={props.mediaUrl} alt={`${item.name}の原本`} />
					) : (
						// oxlint-disable-next-line jsx-a11y/media-has-caption -- user-supplied source has no caption track
						<video
							src={props.mediaUrl}
							controls
							playsInline
							aria-label={`${item.name}の元動画`}
						/>
					)}
				</div>
			)}
			{item?.state === "completed" && (
				<p className="ocr-source-hint">
					行を選ぶと、元資料の位置を確認できます。
				</p>
			)}
			{item?.result?.kind === "video" && (
				<div className="ocr-frames" aria-label="動画の解析時刻">
					{item.result.frames.map((frame, index) => (
						<Button
							key={index}
							variant={props.frameIndex === index ? "default" : "secondary"}
							size="sm"
							onClick={() => props.onFrame?.(index)}
						>
							{frame.timestampSeconds}秒
						</Button>
					))}
				</div>
			)}
		</section>
	);
}
