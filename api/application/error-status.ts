import { analysisErrors } from "../domains/larm/contracts/visual-perception";
import { errorStatus as docling } from "../domains/docling/contracts";
import { errorStatus as ocr } from "../domains/ocr/contracts";
import { attachmentErrors } from "../domains/conversation/contracts";
import { errorStatus as objectRecognition } from "../domains/object-recognition/contracts";
import { errorStatus as capabilities } from "../domains/capabilities/contracts";
import { errorStatus as agentRuntime } from "../domains/agent-runtime/contracts";
import { errorStatus as browser } from "../domains/browser/contracts";
import { errorStatus as compute } from "../domains/compute/contracts";
import { errorStatus as dialogue } from "../domains/dialogue/contracts";
import { errorStatus as inference } from "../domains/inference/contracts";
import { errorStatus as memory } from "../domains/memory/contracts";
import { errorStatus as settings } from "../domains/settings/contracts";
import { errorStatus as toolRuntime } from "../domains/tool-runtime/contracts";
import { errorStatus as toolchainHistory } from "../domains/toolchain-history/contracts";
import { errorStatus as webResearch } from "../domains/web-research/contracts";
import { errorStatus as image } from "../domains/image/contracts";
import { errorStatus as googleAccounts } from "../domains/google-accounts/contracts";
import { errorStatus as worldDocuments } from "../domains/world/contracts/documents";
import type { HttpErrorStatus } from "../infrastructure/http";
import { errorStatus as coding } from "../domains/coding/contracts";
import { errorStatus as larm } from "../domains/larm/contracts";
import { errorStatus as scheduler } from "../domains/scheduler/contracts";
import { errorStatus as taskReports } from "../domains/task-reports/contracts";
import { errorStatus as dots } from "../domains/dots/contracts";
import { errorStatus as tasks } from "../domains/tasks/contracts";
import { errorStatus as timers } from "../domains/timers/contracts";
import { errorStatus as shell } from "../domains/shell/contracts";
import { errorStatus as terminals } from "../domains/terminals/contracts";
import { errorStatus as kanban } from "../domains/kanban/contracts";
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
	invalid_body_size: 413,
	length_required: 411,
	database_writer_queue_full: 503,
	stream_capacity: 503,
	capability_unavailable: 503,
	capability_ref_invalid: 409,
	control_unavailable: 503,
	reference_capacity: 429,
	work_not_found: 404,
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
	analysisErrors,
	docling,
	attachmentErrors,
	objectRecognition,
	ocr,
	capabilities,
	dots,
	shared,
	agentRuntime,
	browser,
	compute,
	dialogue,
	inference,
	memory,
	settings,
	toolRuntime,
	toolchainHistory,
	webResearch,
	image,
	googleAccounts,
	worldDocuments,
	coding,
	larm,
	scheduler,
	taskReports,
	tasks,
	timers,
	shell,
	terminals,
	kanban,
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
