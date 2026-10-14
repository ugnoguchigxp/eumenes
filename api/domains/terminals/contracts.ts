import { z } from "zod";
import type { HttpErrorStatus } from "../../infrastructure/http";

export type TerminalStatus = "running" | "exited";

/** One PTY session as the API shows it. Output never appears here; it is streamed. */
export type TerminalSessionView = {
	id: string;
	title: string;
	status: TerminalStatus;
	/** Advances on every (re)start; a new run starts with an empty screen. */
	run: number;
	exitCode?: number | null;
	startedAt: string;
	endedAt?: string;
};

export type TerminalSessionsView = {
	/** False when the fixed command is not installed on this host. */
	available: boolean;
	revision: number;
	limit: number;
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
	status: z.enum(["running", "exited"]),
	run: z.number().int(),
	exitCode: z.number().int().nullable().optional(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
});
export const terminalSessionsViewSchema = z.strictObject({
	available: z.boolean(),
	revision: z.number().int(),
	limit: z.number().int(),
	sessions: z.array(terminalSessionViewSchema),
});

export const errorStatus = {
	terminal_unavailable: 503,
	terminal_limit_reached: 409,
	terminal_not_found: 404,
	terminal_not_running: 409,
	terminal_running: 409,
	terminal_stream_capacity: 429,
} as const satisfies Record<string, HttpErrorStatus>;
