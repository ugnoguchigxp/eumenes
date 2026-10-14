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
export type KanbanBoardSource = {
	revision: number;
	queue:
		| { state: "running"; waiting: number; handedRunId?: string }
		| {
				state: "paused";
				reason: "tracking_lost" | "stop_unconfirmed" | "restarted";
				waiting: number;
				handedRunId?: string;
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
			actions: KanbanBoardCard["actions"];
		}
	>;
	runs: Array<{
		id: string;
		state: "waiting_turn" | "handed" | "completed" | "blocked" | "cancelled";
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
	if (run.state === "waiting_turn") {
		const waiting = board.runs
			.filter((r) => r.state === "waiting_turn")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return `キュー待ち（${waiting.findIndex((r) => r.id === run.id) + 1}番目）`;
	}
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

function queueOf(board: KanbanBoardSource): KanbanBoardQueue {
	const handed = board.cards.find(
		(c) => c.currentRunId && c.currentRunId === board.queue.handedRunId,
	);
	return {
		state: board.queue.state,
		waiting: board.queue.waiting,
		...(handed ? { runningTitle: handed.title } : {}),
		...(board.queue.state === "paused"
			? { reasonText: QUEUE_PAUSED_TEXT[board.queue.reason] }
			: {}),
	};
}

/** Maps the board source to the DesignSystem props, with the wording of states and reasons. */
export function kanbanBoardProps(
	board: KanbanBoardSource,
): Pick<KanbanBoardProps, "cards" | "queue" | "runnable" | "notRunnableText"> {
	return {
		cards: board.cards.map((card) => ({
			id: card.id,
			revision: card.revision,
			title: card.title,
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
				busy={action.pending}
				message={failed ? action.message : undefined}
				onAdd={({ title, prompt }) => send("kanban-add", { title, prompt })}
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
									...(extra?.note !== undefined ? { note: extra.note } : {}),
								},
					)
				}
				onResumeQueue={() => send("kanban-resume-queue", {})}
			/>
			{unsettled && <Feedback message={action.message} />}
		</>
	);
}
