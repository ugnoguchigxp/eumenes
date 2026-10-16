import type { DialogueDeps, GenerateInput } from "./context";
import type { Progress } from "./progress";
import type { generationTiming } from "./generation-timing";
import { goalsLayerStale } from "./goals-layer";
import { validateMemoryWindow } from "./memory-window";
import { validAttachmentContext } from "./attachment-context";
import { byId } from "../repository";

/** Holds model deltas until the same adoption checks as the final answer pass. */
export function createAnswerStream(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	partials: Progress["partials"],
	publish: Progress["publish"],
	timing: ReturnType<typeof generationTiming>,
	holdBody: () => boolean,
	recallPins: ReadonlyArray<{ messageId: string; digest: string }> = [],
) {
	const { store, memory, agents } = deps;
	const abort = new AbortController();
	const scoped = AbortSignal.any([signal, abort.signal]);
	const validate = () => {
		const failure = store.read((db) => {
			const run = byId(db, input.runId);
			if (run?.status !== "running" || run.revision !== input.revision)
				return "cancelled";
			if (!validAttachmentContext(deps, db, input, run.conversationId))
				return "attachment_source_unavailable";
			if (goalsLayerStale(deps.goals, db, input.goals)) return "memory_stale";
			if (
				input.agent &&
				agents &&
				!agents.validAnswerInTransaction(db, input.agent)
			)
				return "report_invalidated";
			if (input.memory && memory) {
				const verdict = validateMemoryWindow(
					memory,
					db,
					run.id,
					input.memory,
					recallPins,
				);
				if (!verdict.ok) return verdict.reason;
			}
			return null;
		});
		if (failure) abort.abort(new Error(failure));
	};
	// Voice may release clauses before final adoption. Invalidate them immediately on a commit,
	// including while no new LLM delta arrives and a downstream classifier is still pending.
	const stop = store.read((db) => byId(db, input.runId))?.utteranceId
		? store.onCommit(() => {
				const run = store.read((db) => byId(db, input.runId));
				if (run?.status === "completed") return;
				validate();
			})
		: () => {};
	let held = 0;
	const delta = (text: string) => {
		scoped.throwIfAborted();
		if (!holdBody()) validate();
		scoped.throwIfAborted();
		const current = store.read((db) => byId(db, input.runId));
		if (current?.status !== "running" || current.revision !== input.revision)
			throw new Error("cancelled");
		timing.firstDelta(text, holdBody());
		if (holdBody()) {
			// Memory-backed text is not shown or spoken before the adoption check passes.
			held += text.length;
			if (held > 65536) throw new Error("chat_output_too_large");
			return;
		}
		const next = (partials.get(input.runId) ?? "") + text;
		if (next.length > 65536) throw new Error("chat_output_too_large");
		partials.set(input.runId, next);
		publish(input.runId);
	};
	return {
		delta,
		signal: scoped,
		close: stop,
		reset() {
			held = 0;
		},
	};
}

/** Freeze the same provenance for streaming and the final receipt. */
export function answerSession(
	input: GenerateInput,
	recallPins: ReadonlyArray<{ messageId: string }>,
) {
	const window = input.memory?.window;
	return {
		context: input.sessionContext,
		...(window
			? {
					refs: {
						messageIds: [
							...window.shownMessageIds,
							...window.pins.map((pin) => pin.messageId),
							...recallPins.map((pin) => pin.messageId),
						],
						itemIds: window.manifest,
						conversationId: window.conversationId,
					},
				}
			: {}),
	};
}
