import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Button } from "../Button";
import { menuKeyDown } from "../../utils/menuKeyboard";
import type { ObjectRecognitionWorkspaceProps, RecognitionItem } from "./types";

const labels = {
	queued: "準備待ち",
	starting: "起動待ち・解析中",
	running: "動画を解析中",
	cancelling: "取消を確認中",
	completed: "解析完了",
	failed: "解析失敗",
	cancelled: "中止",
};
export const stateLabel = (item: RecognitionItem) =>
	item.state === "cancelled" &&
	item.errorCode === "recognition_result_discarded"
		? "取消済み（処理終了・結果不採用）"
		: labels[item.state];
const canRemove = (item: RecognitionItem) =>
	["completed", "failed", "cancelled"].includes(item.state) &&
	item.captureSave !== "queued";

/** Saved-material menu with per-item delete confirmation; focuses the first item on open. */
export function RecognitionHistory({
	items,
	selectedId,
	busy,
	onRemove,
	onSelect,
	onClose,
}: {
	items: RecognitionItem[];
	selectedId: string | undefined;
	busy: boolean | undefined;
	onRemove: ObjectRecognitionWorkspaceProps["onRemove"];
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const firstHistoryItem = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		firstHistoryItem.current?.focus();
	}, []);
	return (
		<>
			<button
				className="recognition-history-backdrop"
				aria-label="資料一覧を閉じる"
				onClick={onClose}
			/>
			<div
				className="recognition-history-menu"
				role="menu"
				tabIndex={-1}
				aria-label="資料一覧"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					} else menuKeyDown(event);
				}}
			>
				<header>
					<strong>保存した資料</strong>
					<Button
						variant="ghost"
						size="icon"
						aria-label="資料一覧を閉じる"
						onClick={onClose}
					>
						<X size={16} />
					</Button>
				</header>
				{items.length === 0 && <p>保存した資料はありません。</p>}
				<div className="recognition-history-items">
					{items.map((saved, index) => (
						<div key={saved.id} className="recognition-history-entry">
							<button
								ref={index === 0 ? firstHistoryItem : undefined}
								role="menuitem"
								className="recognition-history-item"
								aria-current={saved.id === selectedId ? "true" : undefined}
								onClick={() => onSelect(saved.id)}
							>
								<span className="recognition-history-name">{saved.name}</span>
								<small>{stateLabel(saved)}</small>
							</button>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`${saved.name}を削除`}
								className="recognition-history-delete"
								disabled={!canRemove(saved) || !onRemove || busy}
								title={
									saved.captureSave === "queued"
										? "LARMへの保存が終わるまでお待ちください。"
										: !canRemove(saved)
											? "解析中の資料は、先に取消してください。"
											: undefined
								}
								onClick={() => setPendingDeleteId(saved.id)}
							>
								<Trash2 size={14} />
							</Button>
							{pendingDeleteId === saved.id && canRemove(saved) && (
								<div
									className="recognition-delete-confirm"
									role="group"
									aria-label={`${saved.name}の削除確認`}
								>
									<p>
										「{saved.name}」と解析結果を削除します。元に戻せません。
									</p>
									<div>
										<Button
											variant="destructive"
											size="sm"
											disabled={busy}
											onClick={() => {
												onRemove?.(saved.id);
												onClose();
											}}
										>
											削除する
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setPendingDeleteId(null)}
										>
											やめる
										</Button>
									</div>
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</>
	);
}
