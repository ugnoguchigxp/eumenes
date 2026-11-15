import {
	progressSchema,
	type RunProgress,
} from "../api/domains/dialogue/contracts";
import { readSse } from "./sse";
import type { Transport } from "./transport";
export async function watchRun(
	transport: Transport,
	id: string,
	signal: AbortSignal,
	onProgress: (value: RunProgress) => void,
) {
	let generation: string | undefined;
	let sequence = -1;
	const retired = new Set<string>();
	const result = await readSse(
		(attempt) =>
			transport.call(`/api/runs/${encodeURIComponent(id)}/stream`, {
				signal: attempt,
				headers: { Accept: "text/event-stream" },
			}),
		{
			signal,
			idleMs: 45_000,
			maxFrame: 1_000_000,
			errors: {
				invalid: "invalid_run_stream",
				tooLarge: "run_frame_too_large",
			},
			onEvent({ data }) {
				if (!data) return;
				const value = progressSchema.parse(JSON.parse(data));
				if (value.runId !== id) throw new Error("run_stream_mismatch");
				const live = value.provisional;
				if (live) {
					if (value.status !== "running") throw new Error("invalid_run_stream");
					if (retired.has(live.generationId)) return;
					if (generation === live.generationId && live.sequence <= sequence)
						return;
					if (generation && generation !== live.generationId)
						retired.add(generation);
					generation = live.generationId;
					sequence = live.sequence;
				} else if (generation) {
					retired.add(generation);
					generation = undefined;
					sequence = -1;
				}
				if (value.status !== "running" && value.status !== "completed")
					value.text = "";
				onProgress(value);
				// A final state ends the watch.
				return !["queued", "running"].includes(value.status);
			},
		},
	);
	signal.throwIfAborted();
	if (result !== "stopped") throw new Error("run_stream_disconnected");
}
