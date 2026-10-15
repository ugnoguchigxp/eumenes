import { z } from "zod";
import type { HttpErrorStatus } from "../../infrastructure/http";

/*
 * Fixed contract of the Kanban domain (spec/kanban-claude-code-plan-2026-10-14.md §2, §3.6, §3.8,
 * §3.12). Implementations must not change these shapes; ask the supervisor when a change is needed.
 * Kanban never imports terminals: the hand-over is `KanbanDispatch`, mapped by the application.
 */

/** The only project until multi-project support; the host resolves it to the working directory. */
export const DEFAULT_PROJECT_ID = "eumenes";

export type KanbanColumn = "todo" | "running" | "finished";
/** Cards in `finished` are either done (completed, awaiting the person) or blocked. */
export type KanbanLabel = "done" | "blocker";
export type RunKind = "task" | "followup" | "commit_push" | "commit" | "push";
/** Kanban's view of a run; `handed` until the terminals request is final. */
export type LegacyRunState =
	| "waiting_turn"
	| "handed"
	| "completed"
	| "blocked"
	| "cancelled";
export type RunState = import("./shared-contracts").CommonRunState;
export type BlockerReason =
	| "interrupted"
	| "ended"
	| "unknown"
	| "restarted"
	| "tracking_lost"
	| "cancelled"
	| "send_failed"
	| "stopped_by_person"
	| "resume_failed";
export type QueueState =
	| { state: "running" }
	| {
			state: "paused";
			reason: "tracking_lost" | "stop_unconfirmed" | "restarted";
	  };
/** Card actions; the domain lists the allowed ones per card (business rule, §3.8). */
export type KanbanCardActionName =
	| "edit"
	| "remove"
	| "run"
	| "followup"
	| "commitPush"
	| "commit"
	| "push"
	| "review"
	| "cancel"
	| "stop"
	| "reset"
	| "open";
export type NoticeKind =
	| "done"
	| "blocker"
	| "waiting"
	| "commit_push"
	| "queue_paused"
	| "git_completed"
	| "stopped";

export type KanbanRunView = {
	id: string;
	cardId: string;
	kind: RunKind;
	state: LegacyRunState;
	reason?: BlockerReason;
	/** Fixed at creation: the card revision, title and prompt that are sent. */
	cardRevision: number;
	title: string;
	prompt: string;
	claudeSessionId: string;
	origin: "board" | "conversation";
	/** Terminals request detail for display (filled by the application's board query). */
	requestState?: string;
	activity?: "working" | "idle" | "waiting";
	createdAt: string;
	finishedAt?: string;
};

export type KanbanCardView = {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	column: KanbanColumn;
	/** Present when column is `finished`. */
	label?: KanbanLabel;
	reason?: BlockerReason;
	/** Done only: the person marked it as reviewed. */
	reviewed: boolean;
	/** Done only: a commit & push run finished for the current state of the card. */
	commitPushReported: boolean;
	/** Done only: another card's run started after this card's last run (changes may mix). */
	followedByOtherRun: boolean;
	projectId: string;
	claudeSessionId?: string;
	currentRunId?: string;
	lastReport?: string;
	files: string[];
	position: number;
	/** Allowed now, decided by the domain from the column, label and run state. */
	actions: KanbanCardActionName[];
	createdAt: string;
	updatedAt: string;
};

export type KanbanNoticeView = {
	id: string;
	kind: NoticeKind;
	cardId?: string;
	runId?: string;
	/** Short Japanese text naming the task, e.g. 「タスク『README の手順修正』が終わりました」. */
	text: string;
	read: boolean;
	createdAt: string;
};

/** The board source (`query:kanban.board@1`). */
export type KanbanBoardView = {
	revision: number;
	queue: QueueState & {
		waiting: number;
		handedRunId?: string;
		/**
		 * A Kanban session of the Claude Code screen is working or waiting although no run of the
		 * board is in progress (typed by hand): it holds the next run back. `stale` is terminals'
		 * judgement that its state is old and no longer waited for. Filled by the application.
		 */
		manual?: { activity: "working" | "waiting"; stale: boolean };
	};
	/** False when runs cannot be tracked on this host (hooks unavailable). */
	runnable: boolean;
	cards: KanbanCardView[];
	runs: KanbanRunView[];
};

/** What kanban asks the application to hand to terminals (one at a time). */
export type KanbanDispatch = {
	executorId: string;
	executorRevision: number;
	workspaceRef: string;
	sessionRef: string | null;
	runId: string;
	cardId: string;
	kind: RunKind;
	claudeSessionId: string;
	/** `task` → new conversation; followup/commit_push → the card's conversation. */
	target: "new" | "conversation";
	mode: "work" | "commit";
	git?: KanbanGitGrant;
	projectId: string;
	prompt: string;
	task: string;
	origin: "board" | "conversation";
	conversationId?: string;
};

/* Typed operation inputs live in `api/domains/capabilities/contracts/kanban.ts` (builtin keys). */

/** The common work instruction appended to task and followup prompts (§3.9). */
export const WORK_ONLY_INSTRUCTION =
	"このタスクでは git commit と git push をしないでください。commit と push は利用者が内容を確認した後に、別の依頼として行います。依頼文に commit や push が含まれていても、変更までで止めて報告してください。";

/** The card prompt limit is the typed input's (room for the work-only instruction). */
export { KANBAN_PROMPT_MAX } from "../capabilities/contracts";

export const errorStatus = {
	kanban_card_not_found: 404,
	kanban_card_busy: 409,
	kanban_column_invalid: 409,
	kanban_not_runnable: 503,
	kanban_queue_paused: 409,
	commit_push_requires_board: 403,
	kanban_conversation_busy: 409,
	/** The operation does not fit the card's state (e.g. a follow-up on a card never run). */
	kanban_state_invalid: 409,
	kanban_notice_not_found: 404,
	/** The prompt plus the fixed instructions exceeds what one request can carry. */
	kanban_prompt_too_long: 422,
} as const satisfies Record<string, HttpErrorStatus>;

/* Card operations (P1). Plain shapes; the capabilities contracts validate the same fields. */
export type KanbanAddInput = {
	title: string;
	prompt: string;
	beforeCardId?: string | null;
};
export type KanbanEditInput = {
	cardId: string;
	expectedRevision: number;
	title?: string;
	prompt?: string;
};
export type KanbanMoveInput = {
	cardId: string;
	expectedRevision: number;
	column: "todo" | "finished";
	beforeCardId: string | null;
};
export type KanbanCardRefInput = { cardId: string; expectedRevision: number };
/** What the host knows when a card is shown: whether runs can be tracked on this host. */
export type KanbanViewContext = { runnable: boolean };

export type KanbanFollowupInput = KanbanCardRefInput & { note: string };

/** Who asked and what the host can do now; decided by the application, never by the client. */
export type KanbanOperationContext = {
	origin: "board" | "conversation";
	conversationId?: string;
	/** Runs can be tracked on this host (terminals hooks available). */
	runnable: boolean;
};

/** A terminals request reached a final state (structural; kanban never imports terminals). */
export type KanbanRunFinish = {
	runId: string;
	state: "completed" | "interrupted" | "ended" | "unknown" | "cancelled";
	reason?: string;
	lastReport: string;
	files: readonly string[];
	git?: {
		mode: "commit" | "push" | "commit_push";
		commitSha?: string;
		remoteSha?: string;
		commitVerified: boolean;
		pushVerified: boolean;
	};
};

/** The saved result of one card operation, replayed for the same request id. */
export const kanbanCardReceiptSchema = z.strictObject({
	action: z.enum([
		"added",
		"edited",
		"moved",
		"removed",
		"run",
		"followup",
		"commit_push",
		"commit",
		"push",
		"reviewed",
		"cancelled",
		"stop_requested",
		"reset",
	]),
	cardId: z.string(),
	/** The card revision after the operation (the last one for `removed`). */
	revision: z.number().int().min(1),
	title: z.string(),
	column: z.enum(["todo", "running", "finished"]),
	/** The run an operation created (run, followup, commit_push) or acted on (cancel, stop). */
	runId: z.string().optional(),
});
export const kanbanQueueReceiptSchema = z.strictObject({
	action: z.literal("queue_resumed"),
	/** The queue state after the operation. */
	queue: z.enum(["running", "paused"]),
});
export const kanbanReceiptSchema = z.union([
	kanbanCardReceiptSchema,
	kanbanQueueReceiptSchema,
]);
export type KanbanCardReceipt = z.infer<typeof kanbanCardReceiptSchema>;
export type KanbanQueueReceipt = z.infer<typeof kanbanQueueReceiptSchema>;
export type KanbanReceipt = KanbanCardReceipt | KanbanQueueReceipt;

/** Frozen host authorization, derived from the confirmed source run and registered target. */
export type KanbanGitGrant = {
	grantId: string;
	mode: "commit" | "push" | "commit_push";
	sourceRunId: string;
	remoteId: string;
	head: string;
	snapshotDigest: string;
	files: string[];
	expiresAt: string;
};
