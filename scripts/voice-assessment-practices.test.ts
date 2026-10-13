import { expect, test } from "bun:test";
import {
	assessmentRequest,
	scoreAssessment,
	variants,
} from "./voice-assessment-practices";
import { voiceAssessmentCases } from "./voice-assessment-cases";
import { parseTranscriptAssessment } from "../api/domains/voice-dialogue/service/transcript-language";

test("experiments preserve the same input, host schema and safety thresholds", () => {
	for (const c of voiceAssessmentCases) {
		const baseline = assessmentRequest(c, "baseline");
		for (const v of variants) {
			const candidate = assessmentRequest(c, v);
			expect(candidate.messages[1]).toEqual(baseline.messages[1]);
			if (v !== "examples" && v !== "short-schema")
				expect(candidate.messages).toEqual(baseline.messages);
			if (v === "short-schema") {
				expect(candidate.messages[0]!.content).toStartWith(
					baseline.messages[0]!.content.split("\nOUTPUT_SCHEMA=")[0]!,
				);
				expect(candidate.options.jsonSchema).toEqual(
					assessmentRequest(c, "schema").options.jsonSchema,
				);
			}
			expect(candidate.options.jsonOutput).toBe(true);
			expect(candidate.options.contextPolicy).toBe("exact");
		}
	}
	const waiting = voiceAssessmentCases.find((c) => c.id === "fragment-1")!;
	const ready = parseTranscriptAssessment(
		JSON.stringify({
			status: "identified",
			languages: ["ja"],
			confidence: 0.9,
			relation: "independent",
			readiness: "ready",
			relationConfidence: 0.9,
			readinessConfidence: 0.9,
		}),
	);
	expect(scoreAssessment(waiting, ready).falseAccept).toBe(true);
	for (const field of [
		"confidence",
		"relationConfidence",
		"readinessConfidence",
	] as const)
		expect(scoreAssessment(waiting, { ...ready, [field]: 0.79 }).accepted).toBe(
			false,
		);
	expect(
		scoreAssessment(waiting, { ...ready, languages: ["fr"] }).accepted,
	).toBe(false);
	expect(
		scoreAssessment(waiting, { ...ready, relation: "uncertain" }).accepted,
	).toBe(false);
	expect(
		scoreAssessment(waiting, { ...ready, readiness: "waiting" }).accepted,
	).toBe(false);
});
