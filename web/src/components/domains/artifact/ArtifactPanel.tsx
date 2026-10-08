import type { ArtifactTab } from "../../../domains/artifact";
import { renderSafeMarkdown } from "../conversation/markdownRenderer";

export function ArtifactPanel({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	onCloseAll,
}: {
	tabs: ArtifactTab[];
	activeTabId: string | null;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onCloseAll: () => void;
}) {
	const active = tabs.find((tab) => tab.id === activeTabId);
	return (
		<aside className="artifact-panel" aria-label="アーティファクト">
			<header className="artifact-panel-header">
				<div className="artifact-tabs" role="tablist">
					{tabs.map((tab) => (
						<div className="artifact-tab" key={tab.id}>
							<button
								type="button"
								role="tab"
								aria-selected={tab.id === activeTabId}
								onClick={() => onSelect(tab.id)}
							>
								{tab.title}
							</button>
							<button
								type="button"
								className="artifact-tab-close"
								aria-label={`${tab.title}を閉じる`}
								onClick={() => onClose(tab.id)}
							>
								×
							</button>
						</div>
					))}
				</div>
				<button
					type="button"
					className="artifact-panel-close"
					aria-label="アーティファクトを全て閉じる"
					onClick={onCloseAll}
				>
					×
				</button>
			</header>
			{active && (
				<div className="artifact-panel-body" role="tabpanel">
					<div
						className="markdown-content"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderSafeMarkdown
						dangerouslySetInnerHTML={{
							__html: renderSafeMarkdown(active.content),
						}}
					/>
				</div>
			)}
		</aside>
	);
}
