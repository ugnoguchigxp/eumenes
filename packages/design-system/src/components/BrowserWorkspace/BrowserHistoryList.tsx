import { Button } from "../Button";
import { formatDay, historyEmptyNote } from "./labels";
import type { BrowserHistorySummary } from "./types";

export type BrowserHistoryListProps = {
	histories: readonly BrowserHistorySummary[];
	onOpen: (historyId: string) => void;
};

function meta(history: BrowserHistorySummary) {
	return [
		history.place,
		history.variables.length > 0
			? `変数: ${history.variables.map((v) => v.label).join("、")}`
			: undefined,
		`実行${history.runCount}回`,
		`最終 ${formatDay(history.lastUsedAt)}`,
	]
		.filter(Boolean)
		.join(" ・ ");
}

/** 保存済みの手順の一覧。詳細（Playwrightのソース）はモーダルで読む。 */
export function BrowserHistoryList({
	histories,
	onOpen,
}: BrowserHistoryListProps) {
	return (
		<section className="browser-workspace-section" aria-label="履歴">
			<h3>
				履歴 <span>{histories.length}件</span>
			</h3>
			{histories.length === 0 ? (
				<p className="browser-workspace-empty">{historyEmptyNote}</p>
			) : (
				<ul className="browser-workspace-list">
					{histories.map((history) => (
						<li
							key={history.historyId}
							className="browser-workspace-item"
							data-history-id={history.historyId}
						>
							<div className="browser-workspace-item-main">
								<strong>{history.title}</strong>
								<span className="browser-workspace-url">{meta(history)}</span>
								<small className="browser-workspace-request">
									「{history.request}」
								</small>
								{(history.lastOutcome === "failed" || history.hasCommit) && (
									<span className="browser-workspace-badges">
										{history.lastOutcome === "failed" && (
											<span
												className="browser-workspace-badge"
												data-tone="danger"
											>
												前回失敗
											</span>
										)}
										{history.hasCommit && (
											<span
												className="browser-workspace-badge"
												data-tone="warning"
											>
												許可が必要な操作を含む
											</span>
										)}
									</span>
								)}
							</div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								aria-label={`${history.title}の詳細`}
								onClick={() => onOpen(history.historyId)}
							>
								詳細
							</Button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
