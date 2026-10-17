import { LayoutGrid, OctagonAlert } from "lucide-react";
import { Button } from "../Button";
import { ExecutorLogo } from "./ExecutorLogo";
import type { KanbanBoardProps, KanbanBoardQueue } from "./types";

function queueText(queue: Partial<KanbanBoardQueue>) {
	if (!queue.state) return "状況未取得";
	const parts = [
		queue.runningTitle ? `実行中: 「${queue.runningTitle}」` : "",
		(queue.waiting ?? 0) > 0 ? `待機中 ${queue.waiting}件` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join("・") : "待機なし";
}

type Props = Pick<
	KanbanBoardProps,
	"executors" | "queues" | "queue" | "busy" | "onResumeQueue"
> & {
	filter: string;
	onFilter: (executorId: string) => void;
};

export function ExecutorQueues({
	executors,
	queues,
	queue,
	filter,
	onFilter,
	busy,
	onResumeQueue,
}: Props) {
	const shown = executors
		? executors.map((entry) => ({
				...queues?.find((item) => item.executorId === entry.id),
				executorId: entry.id,
				label: entry.label,
			}))
		: (queues ?? [{ ...queue, executorId: "", label: "実行キュー" }]);
	return (
		<div
			className="kanban-executor-controls"
			role="group"
			aria-label="表示する担当"
		>
			{executors && (
				<Button
					type="button"
					variant="outline"
					className="kanban-executor-all"
					aria-pressed={filter === ""}
					onClick={() => onFilter("")}
				>
					<LayoutGrid aria-hidden="true" size={20} />
					すべて
				</Button>
			)}
			{shown.map((item) => {
				const text =
					item.state === "paused"
						? `${item.label}は停止中: ${item.reasonText ?? "理由を確認できません"}${(item.waiting ?? 0) > 0 ? `（待機中 ${item.waiting}件）` : ""}`
						: queueText(item);
				return (
					<section
						key={item.executorId}
						className="kanban-queue"
						aria-label={item.label}
						data-state={item.state}
					>
						{executors ? (
							<button
								type="button"
								className="kanban-executor-button"
								aria-label={`${item.label}を表示`}
								aria-pressed={filter === item.executorId}
								title={text}
								onClick={() =>
									onFilter(filter === item.executorId ? "" : item.executorId)
								}
							>
								<ExecutorLogo executorId={item.executorId} />
								<span className="kanban-executor-copy">
									<strong>{item.label}</strong>
									<span>{item.state === "paused" ? "キュー停止中" : text}</span>
								</span>
							</button>
						) : (
							item.state !== "paused" && <p>{text}</p>
						)}
						{item.state === "paused" && (
							<>
								<p role="status">
									<OctagonAlert aria-hidden="true" size={16} />
									{text}
								</p>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() => onResumeQueue(item.executorId || undefined)}
								>
									再開
								</Button>
							</>
						)}
						{item.manualText && (
							<p className="kanban-queue-manual">{item.manualText}</p>
						)}
					</section>
				);
			})}
		</div>
	);
}
