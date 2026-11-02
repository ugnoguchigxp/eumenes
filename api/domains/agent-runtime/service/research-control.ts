import type { Database } from "bun:sqlite";
import type { ChildExecution } from "../../tool-runtime";
import type { Task } from "../contracts";
import type { RuntimeContext } from "./runtime-context";
/** Reuse independent controls only after the host has validated the actual autonomous origin. */
export function captureResearchControl(
	ctx: RuntimeContext,
	db: Database,
	t: Task,
	capture: {
		subject: string;
		policySubject: string;
		deadline: number;
		maxOutputTokens: number;
	},
	execution: ChildExecution | undefined,
) {
	const { inference, now } = ctx.deps;
	const autonomous = JSON.parse(t.input_json ?? "{}").autonomous === true;
	if (autonomous && !ctx.deps.autonomousResearch?.(db, t.root_run_id))
		throw new Error("autonomous_origin_invalid");
	return execution || autonomous
		? inference.captureUserControlInTransaction!(db, {
				subject: `${autonomous ? "autonomous" : "execution"}-research:${t.id}-${t.current_step}`,
				route: "subagent",
				deadline: Math.min(capture.deadline, now() + 45000),
				maxOutputTokens: capture.maxOutputTokens,
			})
		: inference.captureControlInTransaction!(db, capture);
}

/** The same live-origin check runs before preparation and again before accepting a result. */
export function authorizeAutonomousTask(
	ctx: RuntimeContext,
	db: Database,
	t: Task,
	fail: import("./task-ops").TaskOps["fail"],
): boolean {
	if (JSON.parse(t.input_json ?? "{}").autonomous !== true) return true;
	if (
		ctx.deps.autonomousResearch?.(db, t.root_run_id) &&
		ctx.deps.inference.captureUserControlInTransaction
	)
		return true;
	fail(db, t, "autonomous_origin_invalid");
	return false;
}
