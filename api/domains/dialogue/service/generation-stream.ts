import type { DialogueDeps, GenerateInput } from "./context";
import type { Progress } from "./progress";
import type { generationTiming } from "./generation-timing";
import { byId } from "../repository";

/** Holds model deltas until the same adoption checks as the final answer pass. */
export function createAnswerStream(
	store: DialogueDeps["store"],
	input: GenerateInput,
	signal: AbortSignal,
	partials: Progress["partials"],
	publish: Progress["publish"],
	timing: ReturnType<typeof generationTiming>,
	holdBody: () => boolean,
) {
	let held = 0;
	const delta = (text: string) => {
		signal.throwIfAborted();
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
		reset() {
			held = 0;
		},
	};
}
