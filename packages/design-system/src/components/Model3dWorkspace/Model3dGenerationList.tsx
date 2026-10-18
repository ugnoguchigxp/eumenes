import { Button } from "../Button";
import type { Model3dGenerationItem } from "./types";

const stateText: Record<Model3dGenerationItem["state"], string> = {
	submitting: "送信中",
	queued: "待機中",
	running: "生成中",
	completed: "完了",
	failed: "失敗",
	cancelled: "取消済み",
};
const active = new Set<Model3dGenerationItem["state"]>([
	"submitting",
	"queued",
	"running",
]);

export type Model3dGenerationListProps = {
	generations: readonly Model3dGenerationItem[];
	highlightedId?: string;
	pending?: boolean;
	onCancel: (id: string) => void;
	onRecheck: (id: string) => void;
	onSelect: (id: string) => void;
};

/** Progress is only the backend's stage wording; no rate is drawn. */
export function Model3dGenerationList({
	generations,
	highlightedId,
	pending,
	onCancel,
	onRecheck,
	onSelect,
}: Model3dGenerationListProps) {
	return (
		<section className="model3d-generations" aria-label="生成の状況">
			<h3>生成の状況</h3>
			{!generations.length && <p>生成した3Dモデルはまだありません。</p>}
			<ul>
				{generations.map((item) => (
					<li
						key={item.id}
						data-state={item.state}
						data-highlighted={item.id === highlightedId}
						aria-current={item.id === highlightedId ? "true" : undefined}
					>
						<div className="model3d-generation-head">
							<strong>{item.title}</strong>
							<span className="model3d-state">{stateText[item.state]}</span>
						</div>
						<p
							className="model3d-stage"
							role={item.state === "failed" ? "alert" : "status"}
						>
							{item.stageLabel}
							{item.state === "failed" && item.errorLabel
								? `（${item.errorLabel}）`
								: ""}
						</p>
						{item.deleted && <p>完成した3Dモデルは削除されています。</p>}
						{item.warnings.length > 0 && (
							<ul className="model3d-warnings" aria-label="注意点">
								{item.warnings.map((warning, index) => (
									<li key={`${index}:${warning}`}>{warning}</li>
								))}
							</ul>
						)}
						<div className="model3d-actions">
							{active.has(item.state) && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={pending}
									aria-label={`${item.title}の生成を取り消す`}
									onClick={() => onCancel(item.id)}
								>
									取り消す
								</Button>
							)}
							{item.state === "failed" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={pending}
									aria-label={`${item.title}の状態を再確認する`}
									onClick={() => onRecheck(item.id)}
								>
									状態を再確認
								</Button>
							)}
							{item.state === "completed" && item.assetId && !item.deleted && (
								<Button
									type="button"
									size="sm"
									aria-label={`${item.title}を表示する`}
									onClick={() => onSelect(item.assetId!)}
								>
									表示する
								</Button>
							)}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
