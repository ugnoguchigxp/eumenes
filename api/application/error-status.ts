export type ErrorStatus = 400 | 409 | 411 | 413 | 503;

const statusByCode: Record<string, ErrorStatus> = {
	request_conflict: 409,
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
