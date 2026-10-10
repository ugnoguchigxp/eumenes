import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger, type LogFields } from "../../../infrastructure/logger";
import type { Receipt } from "../../inference";
import type { Task } from "../contracts";
import { get } from "../repository";
const log = getLogger("agent-runtime");
export function logRejection(
	store: SqliteStore,
	t: Task,
	input: { stepId: string; requestId: string },
	result: { receipt: Receipt; diagnostic?: LogFields },
	jobId: string,
	code: string,
	diagnostic: LogFields,
	issues: LogFields[] = [],
	issueCount = issues.length,
	error?: unknown,
) {
	// A rejection is logged only after its transaction commits. A rollback or
	// stale result must not look like an accepted state transition.
	void Promise.resolve()
		.then(() => {
			const step = store.read((db) =>
				db
					.query("SELECT state,error_code FROM agent_steps WHERE id=?")
					.get(input.stepId),
			) as { state: string; error_code: string | null } | null;
			if (
				!step ||
				!["rejected", "failed"].includes(step.state) ||
				step.error_code !== code
			)
				return;
			const current = store.read((db) => get(db, t.id));
			const fields: LogFields = {
				runId: t.root_run_id,
				taskId: t.id,
				jobId,
				stepId: input.stepId,
				inferenceId: input.requestId,
				attemptId: result.receipt.attemptId,
				kind: t.kind,
				phase: t.phase,
				repairAttempt: t.json_repairs,
				status: current?.state === "queued" ? "repair_scheduled" : "failed",
				controlSchema: "worker",
				...result.diagnostic,
				...diagnostic,
				issueCount,
				reportedIssueCount: issues.length,
			};
			log.warn("agent.control_rejected", fields, error);
			for (const issue of issues)
				log.warn("agent.control_validation_issue", { ...fields, ...issue });
		})
		.catch(() => {});
}
