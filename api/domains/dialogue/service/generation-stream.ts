import type { Database } from "bun:sqlite";
import type { DialogueDeps, GenerateInput } from "./context";
import type { generationTiming } from "./generation-timing";
import { goalsStale } from "./goals-state";
import { validateMemoryWindow } from "./memory-window";
import { validAttachmentContext } from "./attachment-context";
import { byId } from "../repository";

/**
 * Why a generation can no longer be adopted, or null: the run moved on, an attachment, a goal or a memory it
 * stood on was withdrawn, or a forget changed the episode it showed. The same checks run while streaming and
 * at adoption.
 */
export function generationStale(
	deps: DialogueDeps,
	db: Database,
	input: GenerateInput,
): string | null {
	const run = byId(db, input.runId);
	// Handed over: the run waits behind its work's job now, and this generation has nothing left to adopt.
	if (run?.status === "queued" && run.jobId !== input.jobId) return null;
	if (run?.status !== "running" || run.revision !== input.revision)
		return "cancelled";
	if (!validAttachmentContext(deps, db, input, run.conversationId))
		return "attachment_source_unavailable";
	if (goalsStale(deps.goals, db, input.goals)) return "memory_stale";
	if (
		deps.continuity.events.windowVersionInTransaction(db, run.conversationId)
			.version !== input.windowVersion
	)
		return "memory_stale";
	if (input.memory && deps.memory) {
		const verdict = validateMemoryWindow(deps.memory, db, run.id, input.memory);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}

/**
 * Holds model deltas until the adoption checks pass: a spoken reply is short, so nothing is shown or spoken
 * before its generation is adopted. A commit that makes the generation stale aborts it at once.
 */
export function createAnswerStream(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	timing: ReturnType<typeof generationTiming>,
) {
	const { store } = deps;
	const abort = new AbortController();
	const scoped = AbortSignal.any([signal, abort.signal]);
	const validate = () => {
		const failure = store.read((db) => generationStale(deps, db, input));
		if (failure) abort.abort(new Error(failure));
	};
	const stop = store.onCommit(() => {
		const run = store.read((db) => byId(db, input.runId));
		if (run?.status === "completed") return;
		validate();
	});
	let held = 0;
	const delta = (text: string) => {
		scoped.throwIfAborted();
		timing.firstDelta(text);
		held += text.length;
		if (held > 65536) throw new Error("chat_output_too_large");
	};
	return {
		delta,
		signal: scoped,
		close: stop,
		/** Transport cancellation must not erase the source/authority failure that caused it. */
		rethrow(error: unknown): never {
			throw abort.signal.aborted ? abort.signal.reason : error;
		},
		reset() {
			held = 0;
		},
	};
}

/** Freeze the same provenance for streaming and the final receipt. */
export function answerSession(input: GenerateInput) {
	const window = input.memory?.window;
	return {
		context: input.sessionContext,
		...(window
			? {
					refs: {
						messageIds: [
							...window.shownMessageIds,
							...window.pins.map((pin) => pin.messageId),
						],
						itemIds: window.manifest,
					},
				}
			: {}),
	};
}
