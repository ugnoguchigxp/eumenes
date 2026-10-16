import { systemContext } from "../../../infrastructure/system-context";
import type { WorkTask } from "../../tasks";
import type { Supervisor } from "../contracts";
export const supervisorInstruction = systemContext(
	"coding-supervision.contexts.prompt.supervisor-instruction",
	{},
);
export function messages(task: WorkTask, s: Supervisor, allowed: string[]) {
	if (task.kind !== "coding") throw new Error("invalid_coding_task");
	return [
		{ role: "system" as const, content: supervisorInstruction },
		{
			role: "user" as const,
			content: JSON.stringify({
				task: {
					id: task.id,
					request: task.request,
					completionConditions: task.completionConditions,
					phase: task.phase,
					grant: task.grant,
				},
				allowedActions: allowed,
				observation: s.observation,
				verification: {
					checks: s.checks,
					review: s.review,
					commit: s.commit,
					push: s.push,
				},
				remaining: {
					decisions: task.grant.maxDecisions - s.decisionsUsed,
					repairLoops: 2 - s.repairLoops,
				},
			}),
		},
	];
}
