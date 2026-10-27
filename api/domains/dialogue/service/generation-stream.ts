import type { Database } from "bun:sqlite";
import type { DialogueDeps, GenerateInput } from "./context";
import type { generationTiming } from "./generation-timing";
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
	// Handed over: the run waits for its work now (behind its job, or for a task's answer still on this job id), and
	// this generation has nothing left to adopt. Only this generation's hand-over queues it at the next revision.
	if (run?.status === "queued" && run.revision === input.revision + 1)
		return null;
	if (run?.status !== "running" || run.revision !== input.revision)
		return "cancelled";
	if (!validAttachmentContext(deps, db, input, run.conversationId))
		return "attachment_source_unavailable";
	if (
		(deps.conversation.input.cutInTransaction(db, run.conversationId)
			?.revision ?? 0) !== input.inputRevision
	)
		return "memory_stale";
	if (input.memory && deps.memory) {
		const verdict = validateMemoryWindow(deps.memory, db, run.id, input.memory);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}

/**
 * Streams the agent's body to backend speech consumers while adoption still governs stored history.
 * A commit that makes the generation stale aborts both generation and unplayed speech at once.
 */
export function createAnswerStream(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	timing: ReturnType<typeof generationTiming>,
	open: import("./progress").Progress["openAnswerStream"],
) {
	const { store } = deps;
	const abort = new AbortController();
	const scoped = AbortSignal.any([signal, abort.signal]);
	const publish = open(input.runId, crypto.randomUUID(), scoped);
	const validate = () => {
		const failure = store.read((db) => generationStale(deps, db, input));
		if (failure) abort.abort(new Error(failure));
	};
	const stop = store.onCommit(() => {
		const run = store.read((db) => byId(db, input.runId));
		if (run?.status === "completed") return;
		validate();
	});
	validate();
	let body = "";
	const delta = (text: string) => {
		scoped.throwIfAborted();
		timing.firstDelta(text);
		body += text;
		if (body.length > 65536) throw new Error("chat_output_too_large");
		// The agent trims its final reply. Hold boundary whitespace until the following body arrives.
		publish(body.trim());
	};
	return {
		delta,
		signal: scoped,
		close: stop,
		/** Transport cancellation must not erase the source/authority failure that caused it. */
		rethrow(error: unknown): never {
			const reason = abort.signal.aborted ? abort.signal.reason : error;
			abort.abort(reason);
			throw reason;
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
						messageIds: [...window.shownMessageIds],
						itemIds: window.manifest,
					},
				}
			: {}),
	};
}
