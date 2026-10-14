import { Button } from "../Button";
import { Modal } from "../Modal";
import type { KanbanBoardCard } from "./types";

type CommitPushDialogProps = {
	card: KanbanBoardCard;
	onConfirm: () => void;
	onClose: () => void;
};

/** Shown before every commit & push so the person sees the files and the report first. */
export function CommitPushDialog({
	card,
	onConfirm,
	onClose,
}: CommitPushDialogProps) {
	return (
		<Modal
			open
			draggable={false}
			title="commit & push の確認"
			description={`タスク「${card.title}」で変更した内容を commit して push するよう、Claude Code に依頼します。`}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						キャンセル
					</Button>
					<Button type="button" maxLabelLength={40} onClick={onConfirm}>
						commit & push を依頼する
					</Button>
				</>
			}
		>
			<div className="kanban-confirm">
				<section aria-labelledby="kanban-confirm-files">
					<h4 id="kanban-confirm-files">
						変更したファイル（{card.files.length}件）
					</h4>
					{card.files.length > 0 ? (
						<ul className="kanban-files">
							{card.files.map((file) => (
								<li key={file}>{file}</li>
							))}
						</ul>
					) : (
						<p className="kanban-muted">
							記録された変更ファイルはありません。記録のない変更がある場合、Claude
							Code はどのファイルを含めるか尋ねて止まります。
						</p>
					)}
				</section>
				<section aria-labelledby="kanban-confirm-report">
					<h4 id="kanban-confirm-report">最後の報告</h4>
					{card.lastReport ? (
						<p className="kanban-report">{card.lastReport}</p>
					) : (
						<p className="kanban-muted">報告はありません。</p>
					)}
				</section>
				<p className="kanban-muted">
					Eumenes は git を操作しません。内容を確認してから依頼してください。
				</p>
			</div>
		</Modal>
	);
}
