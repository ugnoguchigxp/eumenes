import { z } from "zod";
import type { HttpErrorStatus } from "../../infrastructure/http";

export type TerminalStatus = "running" | "exited";
/** What Claude Code reported last for a running session (from its hooks). */
export type TerminalActivity = "working" | "idle" | "waiting";

/** One PTY session as the API shows it. Output never appears here; it is streamed. */
export type TerminalSessionView = {
	id: string;
	title: string;
	/** Whose session this is: the conversation's direct requests or one Kanban card. */
	owner: SessionOwner;
	mode: SessionMode;
	status: TerminalStatus;
	/** Advances on every (re)start; a new run starts with an empty screen. */
	run: number;
	/** Running only: working on a request, done and waiting for the next, or asking for input. */
	activity?: TerminalActivity;
	/** Name of the task handed over from the conversation that is still in progress. */
	task?: string;
	exitCode?: number | null;
	startedAt: string;
	endedAt?: string;
};

export type TerminalSessionsView = {
	/** False when the fixed command is not installed on this host. */
	available: boolean;
	revision: number;
	limit: number;
	/** Requests handed over from the conversation so far; a screen opens when it grows. */
	requests: number;
	sessions: TerminalSessionView[];
};

const cols = z.number().int().min(2).max(500);
const rows = z.number().int().min(2).max(200);
export const terminalSizeSchema = z.strictObject({ cols, rows });
export const terminalStartSchema = z.strictObject({
	title: z.string().trim().min(1).max(80).optional(),
	cols,
	rows,
});
/** Keystrokes or pasted text, sent in order by the client. */
export const terminalInputSchema = z.strictObject({
	data: z.string().min(1).max(65_536),
});
export const terminalIdSchema = z.uuid();

export const terminalSessionViewSchema = z.strictObject({
	id: z.string(),
	title: z.string(),
	owner: z.string(),
	mode: z.enum(["work", "commit"]),
	status: z.enum(["running", "exited"]),
	run: z.number().int(),
	activity: z.enum(["working", "idle", "waiting"]).optional(),
	task: z.string().optional(),
	exitCode: z.number().int().nullable().optional(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
});
export const terminalSessionsViewSchema = z.strictObject({
	available: z.boolean(),
	revision: z.number().int(),
	limit: z.number().int(),
	requests: z.number().int(),
	sessions: z.array(terminalSessionViewSchema),
});

export const errorStatus = {
	terminal_unavailable: 503,
	terminal_limit_reached: 409,
	terminal_not_found: 404,
	terminal_not_running: 409,
	terminal_running: 409,
	terminal_stream_capacity: 429,
	terminal_hook_forbidden: 403,
	terminal_tracking_unavailable: 503,
	terminal_request_conflict: 409,
	terminal_project_unknown: 400,
	terminal_prompt_invalid: 400,
	terminal_conversation_busy: 409,
} as const satisfies Record<string, HttpErrorStatus>;

/*
 * ---- Work requests (spec/kanban-claude-code-plan-2026-10-14.md §2.2, §3.3–§3.7) ----
 * Fixed contract for the request queue. Implementations must not change these shapes; ask the
 * supervisor when a change is needed.
 */

/** Who a PTY session belongs to: the conversation's direct requests or one Kanban card. */
export type SessionOwner = "direct" | `kanban:${string}`;
/** `work` sessions run with git commit/push denied; `commit` sessions may commit and push. */
export type SessionMode = "work" | "commit";
/**
 * Where a request goes: `new` = a fresh PTY and Claude conversation (`--session-id`),
 * `conversation` = the PTY of `claudeSessionId` (or `--resume` it when none is alive),
 * `current` = the latest live `direct` PTY, else a new `direct` one.
 */
export type RequestTarget = "new" | "conversation" | "current";
export type RequestState =
	| "queued"
	| "sending"
	| "delivered"
	| "started"
	| "completed"
	| "interrupted"
	| "ended"
	| "unknown"
	| "cancelled";
export const TERMINAL_REQUEST_FINAL: ReadonlySet<RequestState> = new Set([
	"completed",
	"interrupted",
	"ended",
	"unknown",
	"cancelled",
]);
export type RequestReason =
	| "send_failed"
	| "restarted"
	| "tracking_lost"
	| "stopped_by_person"
	| "stop_unconfirmed"
	| "session_ended"
	| "resume_failed"
	| "cancelled_by_person";

/** One request to enqueue, inside the caller's writer transaction. Nothing is sent until commit. */
export type EnqueueRequest = {
	/** UUID; the same id again is a replay that returns the saved request. */
	attemptId: string;
	owner: SessionOwner;
	target: RequestTarget;
	/** Required for `new` and `conversation` (the Kanban card's Claude conversation). */
	claudeSessionId?: string;
	mode: SessionMode;
	/** A registered project id; the working directory is resolved by the host, never sent. */
	projectId: string;
	/** Text given to Claude Code, at most 8000 characters. */
	prompt: string;
	/** Short task name (at most 40 characters) used in reports and notifications. */
	task: string;
	origin: "board" | "conversation";
	conversationId?: string;
	/**
	 * Requests of one group are never sent while a live PTY of that group is `working` or
	 * `waiting` (Kanban's single-run invariant, §3.6 (b)). Absent: no group.
	 */
	exclusiveGroup?: "kanban";
};

export type TerminalRequestView = {
	id: string;
	state: RequestState;
	reason?: RequestReason;
	owner: SessionOwner;
	target: RequestTarget;
	mode: SessionMode;
	projectId: string;
	task: string;
	origin: "board" | "conversation";
	conversationId?: string;
	claudeSessionId?: string;
	/** The PTY session the request was sent to (after `sending`). */
	terminalSessionId?: string;
	/** Claude Code's prompt_id of the turn (after `started`). */
	promptId?: string;
	/** Claude Code's last answer (completed only), at most 4000 characters. */
	lastReport?: string;
	/** Files changed by Edit/Write/MultiEdit/NotebookEdit, relative to the project, at most 200. */
	files: string[];
	createdAt: string;
	updatedAt: string;
};

/** A request reached a final state; delivered to in-transaction listeners. */
export type TerminalRequestFinished = {
	attemptId: string;
	state: Exclude<RequestState, "queued" | "sending" | "delivered" | "started">;
	reason?: RequestReason;
	owner: SessionOwner;
	origin: "board" | "conversation";
	conversationId?: string;
	task: string;
	lastReport: string;
	files: string[];
};

/** Resolves a registered project to its working directory (host-owned registry). */
export type ProjectResolver = (projectId: string) => { cwd: string } | null;
