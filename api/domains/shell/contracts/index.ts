import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

export const sizeSchema = z.strictObject({
	cols: z.number().int().min(2).max(500),
	rows: z.number().int().min(2).max(200),
});
export const startSchema = sizeSchema.extend({
	title: z.string().trim().min(1).max(80).optional(),
});
export const inputSchema = z.strictObject({
	data: z.string().min(1).max(65_536),
});
export const runInputSchema = z.strictObject({
	command: z
		.string()
		.trim()
		.min(1)
		.max(8000)
		.regex(
			// eslint-disable-next-line no-control-regex -- Shell input may include newline and tab only.
			/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/,
			"shell_command_invalid",
		),
	task: z.string().trim().min(1).max(40),
	timeoutSeconds: z.number().int().min(1).max(600).optional(),
});
export const enqueueSchema = runInputSchema.extend({
	attemptId: z.uuid(),
	projectId: z.string().min(1),
	origin: z.enum(["conversation", "execution"]),
	conversationId: z.string().optional(),
});
export type EnqueueRun = z.infer<typeof enqueueSchema>;
export type RunState =
	| "queued"
	| "running"
	| "completed"
	| "timed_out"
	| "cancelled"
	| "unknown";
export type RunReason =
	| "cancelled_by_person"
	| "restarted"
	| "spawn_failed"
	| "stop_unconfirmed"
	| "stopped_by_person";
export type ShellRun = Omit<EnqueueRun, "attemptId" | "timeoutSeconds"> & {
	id: string;
	timeoutSeconds: number;
	state: RunState;
	reason?: RunReason;
	digest: string;
	sessionId?: string;
	exitCode?: number | null;
	output: string;
	outputTruncated: boolean;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	updatedAt: string;
};
export type RunFinished = ShellRun & {
	state: Exclude<RunState, "queued" | "running">;
};
export const isFinal = (state: RunState) =>
	state !== "queued" && state !== "running";
export type ProjectResolver = (id: string) => { cwd: string } | null;
export const sessionSchema = z.strictObject({
	id: z.string(),
	title: z.string(),
	kind: z.enum(["shell", "run"]),
	status: z.enum(["running", "exited"]),
	run: z.number().int(),
	exitCode: z.number().int().nullable().optional(),
	state: z
		.enum([
			"queued",
			"running",
			"completed",
			"timed_out",
			"cancelled",
			"unknown",
		])
		.optional(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
});
export const sessionsSchema = z.strictObject({
	available: z.boolean(),
	revision: z.number().int(),
	limit: z.number().int(),
	sessions: z.array(sessionSchema),
});
export type SessionView = z.infer<typeof sessionSchema>;
export const errorStatus = {
	shell_unavailable: 503,
	shell_tracking_unavailable: 503,
	shell_limit_reached: 409,
	shell_not_found: 404,
	shell_not_running: 409,
	shell_running: 409,
	shell_stream_capacity: 429,
	shell_run_not_restartable: 409,
	shell_run_conflict: 409,
	shell_project_unknown: 400,
	shell_command_invalid: 400,
} as const satisfies Record<string, HttpErrorStatus>;
