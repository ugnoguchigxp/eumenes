import { describe, expect, it } from "bun:test";
import { mergeErrorStatus, statusForError } from "./error-status";

/** The status table as it was before each domain declared its own (ARC-10); it must never drift. */
const legacy: Record<string, number> = {
	coding_execution_not_found: 404,
	coding_invalid_cursor: 400,
	coding_workspace_unavailable: 503,
	coding_workspace_busy: 409,
	coding_branch_conflict: 409,
	coding_authority_stale: 409,
	coding_operation_conflict: 409,
	task_not_found: 404,
	task_history_expired: 410,
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

describe("statusForError", () => {
	it("keeps every pre-ARC-10 mapping", () => {
		const actual: Record<string, number> = {};
		for (const code of Object.keys(legacy)) actual[code] = statusForError(code);
		expect(actual).toEqual(legacy);
	});
	it("keeps prefix rules and the 500 fallback", () => {
		expect(statusForError("invalid_anything")).toBe(400);
		expect(statusForError("voice_session_gone")).toBe(400);
		expect(statusForError("stale_thing")).toBe(400);
		expect(statusForError("something_unknown")).toBe(500);
	});
	it("maps the LARM configuration errors", () => {
		expect(statusForError("larm_base_url_unconfigured")).toBe(409);
		expect(statusForError("larm_provider_host_mismatch")).toBe(502);
	});
});

describe("mergeErrorStatus", () => {
	it("accepts the same code with the same status in several tables", () => {
		expect(mergeErrorStatus({ a: 409 }, { a: 409, b: 404 })).toEqual({
			a: 409,
			b: 404,
		});
	});
	it("throws when two tables disagree on a status", () => {
		expect(() => mergeErrorStatus({ a: 409 }, { a: 404 })).toThrow(
			"error_status_conflict:a",
		);
	});
});
