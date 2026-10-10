/** Backend live evaluation reads only the saved connection; conversation text is never saved. */
import { createLiveLarm } from "./live-larm";
import { chooseSpeechDelivery } from "../api/domains/delivery";
import { deliveryCases } from "../api/domains/delivery/test/cases";
import { validationCases } from "../api/domains/delivery/test/validation-cases";
const repeats = Number(process.env.EUMENES_DELIVERY_EVAL_REPEATS ?? 3);
const suite = process.env.EUMENES_DELIVERY_EVAL_SUITE ?? "development";
if (!["development", "validation"].includes(suite))
	throw new Error("invalid_suite");
const cases = suite === "validation" ? validationCases : deliveryCases;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
	throw new Error("invalid_repeats");
const port = createLiveLarm();
let hits = 0,
	expressiveHits = 0,
	expressive = 0,
	unwanted = 0,
	neutral = 0;
try {
	await port.prepareVoice?.(AbortSignal.timeout(30000));
	for (const sample of cases)
		for (let repeat = 0; repeat < repeats; repeat++) {
			const signal = AbortSignal.timeout(5000);
			const delivery = await chooseSpeechDelivery(
				port.judge!.bind(port),
				sample.context.answer,
				signal,
				2000,
				sample.context,
			);
			const predicted = delivery.emotion ?? "none";
			const match =
				predicted === sample.expected &&
				(sample.expected === "none" || delivery.source !== "fallback");
			if (match) hits++;
			if (sample.expected !== "none") {
				expressive++;
				if (match) expressiveHits++;
			} else {
				neutral++;
				if (predicted !== "none") unwanted++;
			}
			console.log(
				JSON.stringify({
					suite,
					case: sample.id,
					repeat,
					expected: sample.expected,
					predicted,
					source: delivery.source,
					confidence: delivery.emotionConfidence,
					reason: delivery.reason,
					latencyMs: delivery.latencyMs,
					match,
				}),
			);
		}
	console.log(
		JSON.stringify({
			summary: true,
			suite,
			samples: repeats * cases.length,
			hits,
			expressiveHits,
			expressive,
			unwanted,
			neutral,
		}),
	);
} finally {
	await port.close();
}
