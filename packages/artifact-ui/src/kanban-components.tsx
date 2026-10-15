import {
	KanbanBoard,
	type KanbanBoardCard,
	type KanbanBoardProps,
	type KanbanBoardQueue,
} from "@eumenes/design-system";
import type { ArtifactEvent, ArtifactRequest } from "./contracts";
import { Feedback, useAction } from "./components";

/*
 * The board source as the Kanban domain publishes it (`KanbanBoardView` in
 * api/domains/kanban/contracts.ts), restricted to what this view reads. artifact-ui does not
 * import API types, so the shape is mirrored here; the Web adapter passes the API view through.
 */
export type KanbanBlockerReason =
	| "interrupted"
	| "ended"
	| "unknown"
	| "restarted"
	| "tracking_lost"
	| "cancelled"
	| "send_failed"
	| "stopped_by_person"
	| "resume_failed";
/** Work typed by hand in a Claude Code session of the board that holds the queue back. */
export type KanbanManualActivity = {
	activity: "working" | "waiting";
	/** Its state is old: the queue no longer waits for it. */
	stale: boolean;
};
export type KanbanBoardSource = {
	revision: number;
	defaultExecutorId?: string;
	executors?: Array<{
		id: string;
		label: string;
		available: boolean;
		unavailableReason?: string;
	}>;
	queues?: Array<{
		executorId: string;
		state: "running" | "paused";
		reason?: string;
		waiting: number;
		activeRunId?: string;
	}>;
	queue:
		| {
				state: "running";
				waiting: number;
				handedRunId?: string;
				manual?: KanbanManualActivity;
		  }
		| {
				state: "paused";
				reason: "tracking_lost" | "stop_unconfirmed" | "restarted";
				waiting: number;
				handedRunId?: string;
				manual?: KanbanManualActivity;
		  };
	runnable: boolean;
	cards: Array<
		Pick<
			KanbanBoardCard,
			| "id"
			| "revision"
			| "title"
			| "prompt"
			| "column"
			| "reviewed"
			| "commitPushReported"
			| "followedByOtherRun"
			| "files"
			| "updatedAt"
		> & {
			label?: "done" | "blocker";
			reason?: KanbanBlockerReason;
			currentRunId?: string;
			lastReport?: string;
			executorId?: string;
			canSelectExecutor?: boolean;
			git?: KanbanBoardCard["git"];
			workspaceBusy?: { executorId: string; state: string };
			actions: KanbanBoardCard["actions"];
		}
	>;
	runs: Array<{
		id: string;
		state:
			| "waiting_turn"
			| "handed"
			| "queued"
			| "dispatched"
			| "running"
			| "waiting"
			| "settling"
			| "stopping"
			| "unknown"
			| "completed"
			| "blocked"
			| "cancelled";
		executorId?: string;
		requestState?: string;
		activity?: "working" | "idle" | "waiting";
		createdAt: string;
	}>;
};
export type KanbanResource = {
	kind: "kanban-board";
	revision: number;
	board: KanbanBoardSource;
};

const BLOCKER_TEXT: Record<KanbanBlockerReason, string> = {
	interrupted: "途中で止まりました（Esc などで中断された可能性があります）",
	ended: "作業担当が終了しました",
	unknown: "実行状況を確認できません（送信中の停止または再起動）",
	restarted: "Eumenes の再起動で実行状況を確認できなくなりました",
	tracking_lost:
		"状態を追えません。フックが届いていません（管理設定・プロキシ・curl を確認してください）",
	cancelled: "送る前に取り消しました",
	send_failed: "送信に失敗しました",
	stopped_by_person: "利用者が止めました",
	resume_failed: "前の会話を再開できませんでした",
};
const QUEUE_PAUSED_TEXT = {
	tracking_lost: "状態を追えないため止めました（フックが届いていません）",
	stop_unconfirmed: "止めたタスクの終了を確認できていません",
	restarted: "再起動で実行状況を確認できなくなったため止めました",
} as const;
export const NOT_RUNNABLE_TEXT =
	"この環境では作業の状態を追えないため実行できません";

function statusText(
	board: KanbanBoardSource,
	card: KanbanBoardSource["cards"][number],
): string | undefined {
	if (card.column !== "running") return undefined;
	const run = board.runs.find((r) => r.id === card.currentRunId);
	if (!run) return undefined;
	if (run.state === "waiting_turn" || run.state === "queued") {
		if (card.workspaceBusy) return "作業場所の引渡し待ち";
		const waiting = board.runs
			.filter(
				(r) =>
					(r.state === "waiting_turn" || r.state === "queued") &&
					r.executorId === run.executorId,
			)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return `キュー待ち（${waiting.findIndex((r) => r.id === run.id) + 1}番目）`;
	}
	const commonState = {
		dispatched: "開始待ち",
		running: "作業中",
		waiting: "対応を待っています",
		settling: "結果を確認中",
		stopping: "停止を確認中",
		unknown: "結果を確認できません",
	};
	if (run.state in commonState)
		return commonState[run.state as keyof typeof commonState];
	if (
		board.queue.state === "paused" &&
		board.queue.reason === "stop_unconfirmed" &&
		board.queue.handedRunId === run.id
	)
		return "停止を確認中";
	if (run.activity === "waiting") return "許可を待っています";
	if (run.requestState === "queued" || run.requestState === "sending")
		return "送信待ち";
	return "作業中";
}

function manualText(manual: KanbanManualActivity): string {
	if (manual.stale)
		return "Claude Code の画面の手入力の作業は状態が古いため、待たずに次のタスクを始めます";
	return manual.activity === "waiting"
		? "Claude Code の画面で手入力の作業が許可を待っています。終わるまで次のタスクは始まりません"
		: "Claude Code の画面で手入力の作業が続いています。終わるまで次のタスクは始まりません";
}

function queueOf(board: KanbanBoardSource): KanbanBoardQueue {
	const handed = board.cards.find(
		(c) => c.currentRunId && c.currentRunId === board.queue.handedRunId,
	);
	return {
		state: board.queue.state,
		waiting: board.queue.waiting,
		...(handed ? { runningTitle: handed.title } : {}),
		...(board.queue.manual
			? { manualText: manualText(board.queue.manual) }
			: {}),
		...(board.queue.state === "paused"
			? { reasonText: QUEUE_PAUSED_TEXT[board.queue.reason] }
			: {}),
	};
}

/** Maps the board source to the DesignSystem props, with the wording of states and reasons. */
export function kanbanBoardProps(
	board: KanbanBoardSource,
): Pick<
	KanbanBoardProps,
	"cards" | "queue" | "runnable" | "notRunnableText" | "executors" | "queues"
> {
	return {
		cards: board.cards.map((card) => ({
			id: card.id,
			revision: card.revision,
			title: card.title,
			executorId: card.executorId,
			executorLabel: board.executors?.find(
				(entry) => entry.id === card.executorId,
			)?.label,
			canSelectExecutor: card.canSelectExecutor,
			git: card.git,
			prompt: card.prompt,
			column: card.column,
			label: card.label,
			statusText: statusText(board, card),
			reasonText:
				card.label === "blocker" && card.reason
					? BLOCKER_TEXT[card.reason]
					: undefined,
			reviewed: card.reviewed,
			commitPushReported: card.commitPushReported,
			followedByOtherRun: card.followedByOtherRun,
			lastReport: card.lastReport,
			files: card.files,
			updatedAt: card.updatedAt,
			actions: card.actions,
		})),
		queue: queueOf(board),
		executors: board.executors?.map((entry) => ({
			...entry,
			unavailableText: entry.available
				? undefined
				: "この担当を利用できません。設定を確認してください",
		})),
		queues: board.queues?.map((queue) => ({
			state: queue.state,
			waiting: queue.waiting,
			executorId: queue.executorId,
			label:
				board.executors?.find((entry) => entry.id === queue.executorId)
					?.label ?? queue.executorId,
			runningTitle: board.cards.find(
				(card) => card.currentRunId === queue.activeRunId,
			)?.title,
			reasonText: queue.reason
				? (QUEUE_PAUSED_TEXT[queue.reason as keyof typeof QUEUE_PAUSED_TEXT] ??
					"理由を確認してください")
				: undefined,
		})),
		runnable: board.runnable,
		notRunnableText: NOT_RUNNABLE_TEXT,
	};
}

const ACTION_EVENT: Record<
	Parameters<KanbanBoardProps["onAction"]>[0],
	ArtifactEvent["action"]
> = {
	remove: "kanban-remove",
	run: "kanban-run",
	followup: "kanban-followup",
	commitPush: "kanban-commit-push",
	commit: "kanban-commit",
	push: "kanban-push",
	review: "kanban-review",
	cancel: "kanban-cancel",
	stop: "kanban-stop",
	reset: "kanban-reset",
	open: "kanban-open",
};

export function KanbanBoardView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "kanban-board") return null;
	const failed =
		!action.pending &&
		(action.status === "rejected" || action.status === "conflict");
	const send = (
		name: ArtifactEvent["action"],
		values: ArtifactEvent["values"],
	) => {
		void action.send(name, values);
	};
	const unsettled =
		!action.pending &&
		(action.status === "indeterminate" || action.status === "pending");
	return (
		<>
			<KanbanBoard
				{...kanbanBoardProps(data.board)}
				title={request.title}
				defaultExecutorId={data.board.defaultExecutorId}
				busy={action.pending}
				message={failed ? action.message : undefined}
				onAdd={({ title, prompt, executorId }) =>
					send("kanban-add", {
						title,
						prompt,
						...(executorId ? { executorId } : {}),
					})
				}
				onAddAndRun={
					data.board.executors
						? ({ title, prompt, executorId }) =>
								send("kanban-add-run", {
									title,
									prompt,
									executorId: executorId ?? "",
								})
						: undefined
				}
				onSelectExecutor={
					data.board.executors
						? (cardId, revision, executorId) =>
								send("kanban-select-executor", {
									cardId,
									expectedRevision: String(revision),
									executorId,
								})
						: undefined
				}
				onInspect={
					data.board.executors
						? (cardId) => send("kanban-inspect", { cardId })
						: undefined
				}
				onEdit={(cardId, revision, change) =>
					send("kanban-edit", {
						cardId,
						expectedRevision: String(revision),
						...change,
					})
				}
				onMove={(cardId, revision, column, beforeCardId) =>
					send("kanban-move", {
						cardId,
						expectedRevision: String(revision),
						column,
						beforeCardId: beforeCardId ?? "",
					})
				}
				onAction={(name, cardId, revision, extra) =>
					send(
						ACTION_EVENT[name],
						name === "open"
							? { cardId }
							: {
									cardId,
									expectedRevision: String(revision),
									...extra,
								},
					)
				}
				onResumeQueue={(executorId) =>
					send("kanban-resume-queue", executorId ? { executorId } : {})
				}
			/>
			{unsettled && <Feedback message={action.message} />}
		</>
	);
}
