import type { ContextCase } from "../../eval/context/case-schema";
import type { TrialScore } from "../../eval/context/scoring";
import { makeCase } from "./case-fixtures";

export const rubricCase = (id: string): ContextCase =>
	makeCase(id, `入力 ${id}`, {
		expect: {
			checks: [{ kind: "brief_spoken_reply" }],
			rubric: [{ axis: "follows_current_request", condition: "従う" }],
		},
	});
export const trialScore = (
	caseId: string,
	trial: number,
	over: Partial<TrialScore> = {},
): TrialScore => ({
	caseId,
	family: "F1",
	split: "holdout",
	trial,
	status: "scored",
	checks: [],
	axes: [],
	pass: true,
	contractViolation: false,
	promptTokens: 100,
	latencyMs: 10,
	adjudicated: false,
	...over,
});
