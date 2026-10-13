import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");
/** Observation of the existing adoption gate; does not decide what may be shown. */
export function generationTiming() {
	const started = performance.now();
	let observed = false;
	return {
		policy(held: boolean) {
			log.info("dialogue.body_policy", { kind: held ? "held" : "streamed" });
		},
		firstDelta(text: string, held: boolean) {
			if (!text || observed) return;
			observed = true;
			log.info("dialogue.first_delta", {
				kind: held ? "held" : "streamed",
				durationMs: performance.now() - started,
			});
		},
	};
}
