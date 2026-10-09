export type ErrorStatus = 400 | 404 | 409 | 410 | 411 | 413 | 429 | 503;

const statusByCode: Record<string, ErrorStatus> = {
	task_not_found: 404,
	task_execution_unavailable: 503,
	task_grant_expired: 409,
	task_runtime_expired: 409,
	task_state_conflict: 409,
	task_fence_conflict: 409,
	task_origin_conflict: 409,
	task_question_conflict: 409,
	task_capacity: 429,
	report_not_ready: 409,
	report_deleted: 410,
	capability_ref_invalid: 409,
	tool_ref_invalid: 409,
	result_capacity: 429,
	reference_capacity: 429,
	capability_unavailable: 503,
	control_unavailable: 503,
	request_conflict: 409,
	timer_not_found: 404,
	notification_not_found: 404,
	notification_claimed: 409,
	claim_invalid: 409,
	operation_expired: 410,
	timer_limit_reached: 429,
	timer_storage_full: 429,
	operation_capacity: 429,
	timer_unavailable: 503,
	revision_conflict: 409,
	voice_sequence_out_of_order: 409,
	voice_utterance_conflict: 409,
	schedule_state_conflict: 409,
	memory_unavailable: 409,
	voice_preview_busy: 409,
	voice_sequence_invalid: 400,
	env_ref_not_allowed: 400,
	payload_too_large: 413,
	length_required: 411,
	database_writer_queue_full: 503,
	queue_full: 503,
	schedule_limit_reached: 503,
	stream_capacity: 503,
	web_research_unavailable: 503,
	web_cache_unavailable: 503,
	web_cache_clear_blocked: 409,
};

const statusByPrefix: Array<[prefix: string, status: ErrorStatus]> = [
	["invalid_", 400],
	["voice_session_", 400],
	["stale_", 400],
];

/** Maps a thrown error message to its HTTP status; unknown codes are 500. */
export function statusForError(message: string): ErrorStatus | 500 {
	const exact = statusByCode[message];
	if (exact) return exact;
	for (const [prefix, status] of statusByPrefix)
		if (message.startsWith(prefix)) return status;
	return 500;
}
