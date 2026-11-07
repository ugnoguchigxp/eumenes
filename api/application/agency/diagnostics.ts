import type { CallOutcome, Decision, Opportunity } from "eumenes-agency";
import { getLogger } from "../../infrastructure/logger";
import type { Conv } from "./host-types";

const log = getLogger("agency");

export function logCalls(c: Conv, calls: readonly CallOutcome[]) {
	for (const call of calls)
		if (call.code !== "applied" && call.code !== "no_change")
			log.info("agency.background_call", {
				subjectId: c.id,
				purpose: call.purpose,
				outcome: call.code,
				validationCode: call.rejectCodes.join(","),
			});
}

export function logDecision(
	c: Conv,
	trigger: Opportunity["trigger"],
	decision: Decision,
	superseded: boolean,
) {
	log.info("agency.decision", {
		subjectId: c.id,
		selectionId: decision.opportunityId,
		kind: trigger,
		decision: decision.action,
		source: decision.source,
		outcome: superseded ? "superseded" : "current",
		validationCode: decision.rejectCodes.join(","),
	});
}
