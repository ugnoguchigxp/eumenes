import { Button } from "../Button";
import { taskCancellable, taskStateLabels } from "./labels";
import type { BrowserTaskItem } from "./types";

export type BrowserTaskListProps = {
	tasks: readonly BrowserTaskItem[];
	disabled?: boolean;
	onCancelTask: (taskId: string) => void;
};

const tones: Record<BrowserTaskItem["state"], string> = {
	queued: "neutral",
	running: "info",
	completed: "success",
	needs_input: "warning",
	failed: "danger",
	cancelled: "muted",
	expired: "muted",
	indeterminate: "warning",
};

/** 依頼ごとの作業状況。取消は待機中・実行中だけに出す。 */
export function BrowserTaskList({
	tasks,
	disabled,
	onCancelTask,
}: BrowserTaskListProps) {
	return (
		<section className="browser-workspace-section" aria-label="作業">
			<h3>
				作業 <span>{tasks.length}件</span>
			</h3>
			{tasks.length === 0 ? (
				<p className="browser-workspace-empty">作業はまだありません。</p>
			) : (
				<ul className="browser-workspace-list">
					{tasks.map((task) => (
						<li
							key={task.taskId}
							className="browser-workspace-item"
							data-state={task.state}
						>
							<div className="browser-workspace-item-main">
								<strong>{task.requestSummary}</strong>
								{task.resultSummary && <span>{task.resultSummary}</span>}
							</div>
							<div className="browser-workspace-badges">
								<span
									className="browser-workspace-badge"
									data-tone={tones[task.state]}
								>
									{taskStateLabels[task.state]}
								</span>
							</div>
							{taskCancellable(task.state) && (
								<div className="browser-workspace-actions">
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={`作業「${task.requestSummary}」を取り消す`}
										disabled={disabled}
										onClick={() => onCancelTask(task.taskId)}
									>
										取り消す
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
