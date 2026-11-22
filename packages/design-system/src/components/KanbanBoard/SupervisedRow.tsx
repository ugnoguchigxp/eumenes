import { Button } from "../Button";
import type { KanbanBoardProps, SupervisedBoardRow } from "./types";

export type ConditionDraft = { revision: number; request: string };

const results = {
	succeeded: "完了",
	partial: "一部達成",
	failed: "失敗",
	cancelled: "取消",
	interrupted: "中断",
};

export function SupervisedRow({
	row,
	busy,
	onControl,
	draft,
	onDraft,
}: {
	row: SupervisedBoardRow;
	busy: boolean;
	onControl?: KanbanBoardProps["onSupervisedControl"];
	draft?: ConditionDraft;
	onDraft: (taskId: string, draft: ConditionDraft | null) => void;
}) {
	const outdated = draft !== undefined && draft.revision !== row.revision;
	return (
		<li className="kanban-card" data-supervised-task={row.taskId}>
			<article aria-label={row.title}>
				<h4>{row.title}</h4>
				{row.outcome && <strong>{results[row.outcome]}</strong>}
				<p>{row.reason}</p>
				{row.designRevision != null ||
				row.blockerRef ||
				row.evidenceRefs?.length ||
				row.result ? (
					<details>
						<summary>作業の詳細</summary>
						{row.designRevision != null && (
							<p>設計書 第{row.designRevision}版</p>
						)}
						{row.blockerRef && (
							<p>
								待機先 <code>{row.blockerRef}</code>
							</p>
						)}
						{row.result?.summary && row.result.summary !== row.reason && (
							<p>{row.result.summary}</p>
						)}
						{row.result?.fulfilled.map((item) => (
							<p key={item}>確認済み　{item}</p>
						))}
						{row.result?.missing.map((item) => (
							<p key={item}>未確認　{item}</p>
						))}
						{!!row.evidenceRefs?.length && (
							<div>
								<span>証跡</span>
								<ul>
									{row.evidenceRefs.map((ref) => (
										<li key={ref}>
											<code>{ref}</code>
										</li>
									))}
								</ul>
							</div>
						)}
					</details>
				) : null}
				{onControl &&
					row.column !== "finished" &&
					(draft ? (
						<form
							onSubmit={async (event) => {
								event.preventDefault();
								if (!draft.request.trim() || busy || outdated) return;
								const accepted = await onControl(
									row,
									"amend",
									draft.request.trim(),
								);
								if (accepted !== false) onDraft(row.taskId, null);
							}}
						>
							<label>
								変更する条件
								<textarea
									value={draft.request}
									onChange={(event) =>
										onDraft(row.taskId, {
											...draft,
											request: event.target.value,
										})
									}
									required
									disabled={busy}
									maxLength={8000}
								/>
							</label>
							{outdated && (
								<>
									<p role="status">入力中に作業の状態が更新されました。</p>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() =>
											onDraft(row.taskId, { ...draft, revision: row.revision })
										}
									>
										更新後の状態を確認した
									</Button>
								</>
							)}
							<Button
								type="submit"
								size="sm"
								disabled={busy || outdated || !draft.request.trim()}
							>
								条件を送る
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => onDraft(row.taskId, null)}
							>
								閉じる
							</Button>
						</form>
					) : (
						<div className="kanban-card-actions">
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() =>
									onDraft(row.taskId, { revision: row.revision, request: "" })
								}
							>
								条件変更
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => onControl(row, "cancel")}
							>
								作業を取り消す
							</Button>
						</div>
					))}
			</article>
		</li>
	);
}
