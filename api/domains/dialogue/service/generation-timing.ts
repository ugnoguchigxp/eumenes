import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");
/** Observation of the first body delta of a generation; does not decide adoption or delivery. */
export function generationTiming() {
	const started = performance.now();
	let observed = false;
	return {
		firstDelta(text: string) {
			if (!text || observed) return;
			observed = true;
			log.info("dialogue.first_delta", {
				kind: "streamed",
				durationMs: performance.now() - started,
			});
		},
	};
}
