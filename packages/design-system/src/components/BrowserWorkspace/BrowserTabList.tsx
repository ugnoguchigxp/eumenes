import { Button } from "../Button";
import { blockedTabNote, tabStatusLabels } from "./labels";
import type { BrowserTabItem } from "./types";

export type BrowserTabListProps = {
	tabs: readonly BrowserTabItem[];
	disabled?: boolean;
	onFocusTab: (tabRef: string) => void;
	onCloseTab: (tabRef: string) => void;
};

/** 開いているタブの一覧。現在のタブへの切り替えと閉じる操作だけを出す。 */
export function BrowserTabList({
	tabs,
	disabled,
	onFocusTab,
	onCloseTab,
}: BrowserTabListProps) {
	return (
		<section className="browser-workspace-section" aria-label="タブ">
			<h3>
				タブ <span>{tabs.length}件</span>
			</h3>
			{tabs.length === 0 ? (
				<p className="browser-workspace-empty">開いているタブはありません。</p>
			) : (
				<ul className="browser-workspace-list">
					{tabs.map((tab) => {
						const closed = tab.status === "closed";
						const lost = tab.status === "lost";
						const blocked = tab.status === "blocked";
						return (
							<li
								key={tab.tabRef}
								className="browser-workspace-item"
								data-active={tab.active || undefined}
								data-status={tab.status}
							>
								<div className="browser-workspace-item-main">
									<strong>{tab.title || tab.url}</strong>
									<span className="browser-workspace-url">{tab.url}</span>
									{tab.currentTaskLabel && (
										<span>作業: {tab.currentTaskLabel}</span>
									)}
									{blocked && <span>{blockedTabNote}</span>}
								</div>
								<div className="browser-workspace-badges">
									{tab.active && (
										<span className="browser-workspace-badge" data-tone="info">
											現在のタブ
										</span>
									)}
									<span
										className="browser-workspace-badge"
										data-tone={
											lost || blocked ? "danger" : closed ? "muted" : "neutral"
										}
									>
										{tabStatusLabels[tab.status]}
									</span>
								</div>
								<div className="browser-workspace-actions">
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={`${tab.title || tab.url}へ切り替える`}
										disabled={
											disabled || tab.active || closed || lost || blocked
										}
										onClick={() => onFocusTab(tab.tabRef)}
									>
										このタブへ切り替える
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										aria-label={`${tab.title || tab.url}を閉じる`}
										disabled={
											disabled ||
											closed ||
											lost ||
											blocked ||
											tab.status === "busy"
										}
										onClick={() => onCloseTab(tab.tabRef)}
									>
										閉じる
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
