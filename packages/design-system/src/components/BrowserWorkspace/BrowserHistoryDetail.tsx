import { useState } from "react";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { CopyClipButton } from "../CopyClipButton";
import { Modal } from "../Modal";
import { formatDateTime, historyDeleteNote, historyKindLabels } from "./labels";
import type { BrowserHistoryAction, BrowserHistoryDetail } from "./types";

export type BrowserHistoryDetailProps = {
	/** 一覧にある名称。詳細を読むまでの見出しに使う。 */
	fallbackTitle: string;
	detail?: BrowserHistoryDetail;
	error?: string;
	pending?: boolean;
	/** 削除などの結果の説明。モーダルの上では背面の表示が見えないため、ここにも出す。 */
	message?: string;
	onClose: () => void;
	onDelete: (historyId: string, expectedRevision: number) => void;
};

function actionLine(action: BrowserHistoryAction) {
	return [
		historyKindLabels[action.kind],
		action.element,
		action.variable ? `変数: ${action.variable}` : undefined,
		action.place,
	]
		.filter(Boolean)
		.join(" ・ ");
}

function Body({ detail }: { detail: BrowserHistoryDetail }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="browser-history-detail">
			<section aria-label="依頼">
				<h4>依頼</h4>
				<p className="browser-history-request">{detail.request}</p>
			</section>
			<section aria-label="変数">
				<h4>変数</h4>
				{detail.variables.length === 0 ? (
					<p>変数はありません。</p>
				) : (
					<>
						<ul>
							{detail.variables.map((v) => (
								<li key={v.name}>
									<code>{v.name}</code> {v.label}
								</li>
							))}
						</ul>
						<p className="browser-workspace-feedback">
							実行ごとに依頼から決まります
						</p>
					</>
				)}
			</section>
			<section aria-label="手順">
				<h4>手順</h4>
				<ol>
					{detail.steps.map((step, index) => (
						<li key={`${index}:${step.label}`}>
							<strong>{step.label}</strong>
							<p>{step.expectation}</p>
						</li>
					))}
				</ol>
			</section>
			<section aria-label="操作">
				<h4>操作</h4>
				<ol>
					{detail.actions.map((action) => (
						<li key={action.seq} value={action.seq}>
							{actionLine(action)}
						</li>
					))}
				</ol>
			</section>
			<section aria-label="Playwrightのソース">
				<h4>Playwrightのソース</h4>
				<div className="browser-workspace-actions">
					<CopyClipButton
						text="コピー"
						copyValue={detail.source}
						onCopied={() => setCopied(true)}
					/>
					{copied && <output aria-live="polite">コピーしました。</output>}
				</div>
				<pre className="browser-history-source">
					<code>{detail.source}</code>
				</pre>
			</section>
			<section aria-label="情報">
				<h4>情報</h4>
				<dl className="browser-history-info">
					<dt>保存日時</dt>
					<dd>{formatDateTime(detail.createdAt)}</dd>
					<dt>更新日時</dt>
					<dd>{formatDateTime(detail.updatedAt)}</dd>
					<dt>実行回数</dt>
					<dd>{detail.runCount}回</dd>
					<dt>失敗回数</dt>
					<dd>{detail.failureCount}回</dd>
				</dl>
			</section>
		</div>
	);
}

/** 履歴の詳細モーダル。削除は確認を挟み、拒否されたときはモーダルを開いたまま理由を出す。 */
export function BrowserHistoryDetailModal({
	fallbackTitle,
	detail,
	error,
	pending,
	message,
	onClose,
	onDelete,
}: BrowserHistoryDetailProps) {
	const [confirming, setConfirming] = useState(false);
	return (
		<>
			<Modal
				open
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
				title={detail?.title ?? fallbackTitle}
				draggable={false}
				footer={
					<>
						<Button
							type="button"
							variant="destructive"
							disabled={!detail || pending}
							onClick={() => setConfirming(true)}
						>
							削除
						</Button>
						<Button type="button" variant="outline" onClick={onClose}>
							閉じる
						</Button>
					</>
				}
			>
				{detail ? (
					<Body detail={detail} />
				) : error ? (
					<p role="alert">{error}</p>
				) : (
					<output>読み込み中です。</output>
				)}
				{message && <output aria-live="polite">{message}</output>}
			</Modal>
			{detail && (
				<ConfirmModal
					open={confirming}
					onOpenChange={setConfirming}
					title="履歴を削除"
					description={historyDeleteNote}
					confirmText="削除する"
					variant="destructive"
					onConfirm={() => {
						setConfirming(false);
						onDelete(detail.historyId, detail.revision);
					}}
				/>
			)}
		</>
	);
}
