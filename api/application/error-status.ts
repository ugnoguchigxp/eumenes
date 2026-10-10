import type { HttpErrorStatus } from "../infrastructure/http";
import { errorStatus as coding } from "../domains/coding/contracts";
import { errorStatus as larm } from "../domains/larm/contracts";
import { errorStatus as scheduler } from "../domains/scheduler/contracts";
import { errorStatus as taskReports } from "../domains/task-reports/contracts";
import { errorStatus as tasks } from "../domains/tasks/contracts";
import { errorStatus as timers } from "../domains/timers/contracts";
import { errorStatus as voiceDialogue } from "../domains/voice-dialogue/contracts";

export type ErrorStatus = HttpErrorStatus;

/**
 * Codes thrown by several domains or by infrastructure, which therefore belong to no single
 * domain. A domain's own codes live in its `contracts` as `errorStatus`.
 */
const shared = {
	request_conflict: 409,
	revision_conflict: 409,
	queue_full: 503,
	payload_too_large: 413,
	length_required: 411,
	database_writer_queue_full: 503,
	stream_capacity: 503,
} as const satisfies Record<string, ErrorStatus>;

/**
 * Codes of domains whose contracts are not yet migrated to `errorStatus` (agent-runtime,
 * capabilities, tool-runtime, memory, settings, web-research). Move each entry into its domain's
 * contracts when that domain is next edited.
 */
const pending = {
	report_not_ready: 409,
	report_deleted: 410,
	capability_ref_invalid: 409,
	tool_ref_invalid: 409,
	result_capacity: 429,
	reference_capacity: 429,
	capability_unavailable: 503,
	control_unavailable: 503,
	memory_unavailable: 409,
	env_ref_not_allowed: 400,
	web_research_unavailable: 503,
	web_cache_unavailable: 503,
	web_cache_clear_blocked: 409,
} as const satisfies Record<string, ErrorStatus>;

/**
 * Merges status tables. The same code may appear in several tables only with the same status;
 * a disagreement is a programming error and fails at module load.
 */
export function mergeErrorStatus(
	...tables: Array<Readonly<Record<string, ErrorStatus>>>
): Record<string, ErrorStatus> {
	const merged: Record<string, ErrorStatus> = {};
	for (const table of tables)
		for (const [code, status] of Object.entries(table)) {
			if (merged[code] !== undefined && merged[code] !== status)
				throw new Error(`error_status_conflict:${code}`);
			merged[code] = status;
		}
	return merged;
}

const statusByCode = mergeErrorStatus(
	shared,
	pending,
	coding,
	larm,
	scheduler,
	taskReports,
	tasks,
	timers,
	voiceDialogue,
);

const statusByPrefix: Array<[prefix: string, status: ErrorStatus]> = [
	["invalid_", 400],
	["voice_session_", 400],
	["stale_", 400],
];

/** Maps a thrown error message to its HTTP status; unknown codes are 500. */
export function statusForError(message: string): ErrorStatus | 500 {
	const exact = Object.hasOwn(statusByCode, message)
		? statusByCode[message]
		: undefined;
	if (exact) return exact;
	for (const [prefix, status] of statusByPrefix)
		if (message.startsWith(prefix)) return status;
	return 500;
}
