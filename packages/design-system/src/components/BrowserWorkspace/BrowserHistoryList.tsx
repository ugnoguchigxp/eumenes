import { useState } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "../Button";
import { Input } from "../Input";
import { replayStatusLine } from "./BrowserHistoryReplay";
import { formatDay, historyEmptyNote, replayLabels } from "./labels";
import type { BrowserHistorySummary, BrowserReplayItem } from "./types";

const VALUE_MAX_LENGTH = 200;

export type BrowserHistoryListProps = {
	histories: readonly BrowserHistorySummary[];
	/** 各履歴の最新のリプレイ（新しい順）。実行中なら「実行中」と中止を出す。 */
	replays: readonly BrowserReplayItem[];
	pending?: boolean;
	onOpen: (historyId: string) => void;
	onReplay: (
		historyId: string,
		expectedRevision: number,
		values: Record<string, string>,
	) => void;
	onCancelReplay: (replayId: string) => void;
};

function meta(history: BrowserHistorySummary) {
	return [
		history.place,
		`実行${history.runCount}回`,
		`最終 ${formatDay(history.lastUsedAt)}`,
	]
		.filter(Boolean)
		.join(" ・ ");
}

/** 再生できない理由。再生できるなら undefined。送信などを含む履歴は詳細の確認から実行する。 */
function blockedLine(history: BrowserHistorySummary) {
	if (!history.replay) return replayLabels.unavailable;
	if (history.replay.blocked !== null)
		return history.replay.blockedLabel ?? replayLabels.blockedFallback;
	if (history.hasCommit) return replayLabels.commitInDetail;
	return undefined;
}

/**
 * 保存済みの手順の一覧。変数を入れて再生ボタンで新しいタブに実行する。詳細（Playwrightのソース）はモーダルで読む。
 */
export function BrowserHistoryList({
	histories,
	replays,
	pending,
	onOpen,
	onReplay,
	onCancelReplay,
}: BrowserHistoryListProps) {
	const [values, setValues] = useState<Record<string, Record<string, string>>>(
		{},
	);
	return (
		<section className="browser-workspace-section" aria-label="履歴">
			<h3>
				履歴 <span>{histories.length}件</span>
			</h3>
			{histories.length === 0 ? (
				<p className="browser-workspace-empty">{historyEmptyNote}</p>
			) : (
				<ul className="browser-workspace-list">
					{histories.map((history) => {
						const latest = replays.find(
							(r) => r.historyId === history.historyId,
						);
						const running = latest?.state === "running";
						const own = values[history.historyId] ?? {};
						const blocked = blockedLine(history);
						const filled = history.variables.every(
							(v) => (own[v.name] ?? "").trim() !== "",
						);
						const ended =
							latest && !running ? replayStatusLine(latest) : undefined;
						return (
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
									{history.variables.length > 0 && (
										<div className="browser-history-row-fields">
											{history.variables.map((v) => (
												<label
													key={v.name}
													className="browser-history-row-field"
												>
													<span>{v.label}</span>
													<Input
														type="text"
														required
														maxLength={VALUE_MAX_LENGTH}
														value={own[v.name] ?? ""}
														disabled={running || blocked !== undefined}
														onChange={(e) =>
															setValues((previous) => ({
																...previous,
																[history.historyId]: {
																	...previous[history.historyId],
																	[v.name]: e.target.value,
																},
															}))
														}
													/>
												</label>
											))}
										</div>
									)}
									{(running ||
										history.lastOutcome === "failed" ||
										history.hasCommit) && (
										<span className="browser-workspace-badges">
											{running && (
												<span
													className="browser-workspace-badge"
													data-tone="info"
												>
													{replayLabels.runningBadge}
												</span>
											)}
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
									{blocked && (
										<small className="browser-workspace-feedback">
											{blocked}
										</small>
									)}
									{ended && (
										<output className="browser-workspace-feedback">
											{ended}
										</output>
									)}
								</div>
								<div className="browser-history-row-actions">
									{running && latest ? (
										<Button
											type="button"
											variant="outline"
											size="icon"
											title={replayLabels.cancel}
											aria-label={`${history.title}の再生を中止`}
											disabled={pending}
											onClick={() => onCancelReplay(latest.replayId)}
										>
											<Square aria-hidden="true" />
										</Button>
									) : (
										<Button
											type="button"
											variant="outline"
											size="icon"
											title={replayLabels.play}
											aria-label={`${history.title}を${replayLabels.play}`}
											disabled={pending || blocked !== undefined || !filled}
											onClick={() =>
												onReplay(
													history.historyId,
													history.revision,
													Object.fromEntries(
														history.variables.map((v) => [
															v.name,
															own[v.name] ?? "",
														]),
													),
												)
											}
										>
											<Play aria-hidden="true" />
										</Button>
									)}
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={`${history.title}の詳細`}
										onClick={() => onOpen(history.historyId)}
									>
										詳細
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
