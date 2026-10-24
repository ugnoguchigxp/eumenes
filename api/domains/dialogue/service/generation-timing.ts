import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");
/** Observation of the first held delta of a generation; does not decide what may be shown. */
export function generationTiming() {
	const started = performance.now();
	let observed = false;
	return {
		firstDelta(text: string) {
			if (!text || observed) return;
			observed = true;
			log.info("dialogue.first_delta", {
				kind: "held",
				durationMs: performance.now() - started,
			});
		},
	};
}
