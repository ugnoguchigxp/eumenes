import type { Prepared } from "../../capabilities";
import { toolRuntimeOf } from "../../capabilities";
import type { Task } from "../contracts";
import { get, update } from "../repository";
import { guidedActionFor, type GuidedAction } from "./guided-contract";
import { saveGuidedReport } from "./guided-report";
import type { RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import type { Tx, Claim, StepInput } from "./step-actions";

export function applyGuidedAction(
	ctx: RuntimeContext,
	ops: TaskOps,
	db: Tx,
	t: Task,
	root: Task,
	claim: Claim,
	input: StepInput,
	p: Prepared,
	raw: unknown,
	invoke: (action: Extract<GuidedAction, { action: "invoke" }>) => void,
) {
	const action = guidedActionFor(p).parse(raw);
	if (action.action === "wait") {
		if (
			!ctx.deps.tools
				.invocationsInTransaction(db, t.id)
				.some((i) => i.state === "pending" && !i.superseded)
		)
			throw new Error("research_no_progress");
		ops.waitForTools(db, t, claim.jobId);
	} else if (action.action === "invoke") {
		invoke(action);
	} else {
		if (
			!ctx.deps.tools
				.invocationsInTransaction(db, t.id)
				.some((i) => toolRuntimeOf(i.toolRevisionId)?.operation !== "recipe") &&
			input.grants.length
		)
			throw new Error("invalid_report");
		saveGuidedReport(
			db,
			t,
			action.report,
			input.catalog,
			ctx.deps.tools,
			ctx.deps.now(),
			{ hook: ctx.deps.onSearchReport, packageId: p.package.id },
		);
		for (const id of ctx.deps.tools.cancelInTransaction(db, t.id))
			ctx.state.abortJobs.add(id);
		db.query("UPDATE agent_tasks SET report_state='available' WHERE id=?").run(
			t.id,
		);
		update(db, get(db, t.id)!, "completed", "completed");
		ops.ready(db, root, null, t.id);
		ctx.state.releases.add(t.id);
	}
}
