import {useState} from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import type { KanbanBoardCard,KanbanBoardProps } from "./types";

type CommitPushDialogProps = {
	/** The card as the person is looking at it: what they confirm is exactly this revision. */
	card: KanbanBoardCard;
	/** The card as it is now; when it moved on, the confirmation no longer counts. */
	current: KanbanBoardCard;
	mode?:"commitPush"|"commit"|"push";
	onConfirm: (extra?:Parameters<KanbanBoardProps["onAction"]>[3]) => void;
	/** What the dialog shows next: null closes it. */
	onShow: (card: KanbanBoardCard | null) => void;
};

/** Shown before every commit & push so the person sees the files and the report first. */
export function CommitPushDialog({
	card,
	current,
	onConfirm,
	mode="commitPush",
	onShow,
}: CommitPushDialogProps) {
	const [remoteId,setRemoteId]=useState(card.git?.targets[0]?.id??"");
	const label=mode==="commitPush"?"commit & push":mode;
	const changed = current.revision !== card.revision;
	const onClose = () => onShow(null);
	// The current card has to be confirmed again, unless it can no longer be pushed.
	const onRefresh = () =>
		onShow(current.actions.includes(mode) ? current : null);
	return (
		<Modal
			open
			draggable={false}
			title={`${label} の確認`}
			description={`タスク「${card.title}」の${label}を、${card.executorLabel??"Claude Code"}に依頼します。`}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						キャンセル
					</Button>
					{changed ? (
						<Button type="button" maxLabelLength={40} onClick={onRefresh}>
							最新の内容を確認する
						</Button>
					) : (
						<Button type="button" maxLabelLength={40} onClick={()=>onConfirm(card.git?{sourceRunId:card.git.sourceRunId,head:card.git.head,snapshotDigest:card.git.snapshotDigest,remoteId}:undefined)}>
							{label} を依頼する
						</Button>
					)}
				</>
			}
		>
			<div className="kanban-confirm">
				{card.git && <section aria-label="Gitの対象">
				 <p>branch: {card.git.branch}</p><p>HEAD: {card.git.head}</p>
				 {card.git.commitSha && <p>送信するcommit: {card.git.commitSha}</p>}
				 <label>送信先<select value={remoteId} onChange={e=>setRemoteId(e.target.value)}>{card.git.targets.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
				 <p>確認したファイルの内容と送信先に限定して実行します。</p>
				</section>}
				{changed && (
					<p className="kanban-message" role="alert">
						確認している間にタスクの内容が変わりました。下の内容は変更前です。最新の内容を確認し直してください。
					</p>
				)}
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
							記録された変更ファイルはありません。記録のない変更がある場合、担当が確認を求めて止まります。
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
					{card.git?"記録した内容との一致を確認し、Git工程の結果を照合します。":"Eumenes は git を操作しません。内容を確認してから依頼してください。"}
				</p>
			</div>
		</Modal>
	);
}
