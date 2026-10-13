import { buildContext, runCheck } from "./checks";
import type {
	CriterionResult,
	Criteria,
	FailureClass,
	JudgeResult,
	RunEvidence,
	Termination,
} from "./types";

const ENVIRONMENT_STOPS: Termination["reason"][] = [
	"environment_error",
	"driver_error",
	"precondition_failed",
];
const TESTER_STOPS: Termination["reason"][] = [
	"give_up",
	"budget_wall",
	"budget_actions",
	"budget_model_calls",
	"budget_cost",
	"tester_error",
	"forbidden_action",
];

/**
 * Decides one run from host observations, passively observed receipts and screen text.
 * The tester's own claim ("done") only says the run finished; it never makes a criterion
 * pass. A tester that gives up or exhausts its budget leaves the run inconclusive.
 */
export function judge(criteria: Criteria, ev: RunEvidence): JudgeResult {
	const ctx = buildContext(criteria, ev);
	const results: CriterionResult[] = criteria.items.map((item) => {
		try {
			const outcome = runCheck(ctx, item);
			return { id: item.id, required: item.required, ...outcome };
		} catch (error) {
			return {
				id: item.id,
				required: item.required,
				status: "unknown",
				code: "check_threw",
				detail: error instanceof Error ? error.message : String(error),
				class: "environment",
			};
		}
	});
	const result = (
		verdict: JudgeResult["verdict"],
		failureClass: FailureClass | null,
		reasonCode: string,
		reviewRequired = false,
	): JudgeResult => ({
		verdict,
		failureClass,
		reasonCode,
		criteria: results,
		reviewRequired,
	});
	const required = results.filter((r) => r.required);
	const stop = ev.termination.reason;

	if (required.some((r) => r.class === "criteria"))
		return result("inconclusive", "criteria", "criteria_invalid");
	if (ENVIRONMENT_STOPS.includes(stop))
		return result("inconclusive", "environment", stop);
	if (required.some((r) => r.status === "unknown" && r.class === "environment"))
		return result("inconclusive", "environment", "host_evidence_unavailable");

	// A violation alone does not say who caused it: the tester may have misread the goal (e.g.
	// started a second, differently sized timer). Only a check that attributes its violation
	// to the product makes the class `product`; the rest await the independent review.
	const wrong = required.filter((r) => r.status === "violated");
	if (wrong.length)
		return result(
			"failure",
			wrong.some((r) => r.class === "product") ? "product" : "undetermined",
			wrong[0]!.code,
			true,
		);
	if (TESTER_STOPS.includes(stop))
		return result("inconclusive", "tester", stop);

	// The tester reported completion; judge what the host and the screen show.
	if (required.every((r) => r.status === "met"))
		return result("success", null, "all_required_met");
	// A goal that is observably not reached is a failure even if other evidence is missing.
	if (required.some((r) => r.status === "unmet"))
		return result("failure", "undetermined", "criteria_unmet", true);
	return result("inconclusive", "undetermined", "evidence_gap", true);
}
