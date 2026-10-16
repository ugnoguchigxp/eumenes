import type { Prepared } from "../../capabilities";
import { toolRuntimeOf } from "../../capabilities";
import type { Task } from "../contracts";
import { get, update } from "../repository";
import { guidedAction, type GuidedAction } from "./guided-contract";
import { saveGuidedReport } from "./guided-report";
import { createWebReadPlan } from "./web-read-plan";
import { webReadState, saveWebReadState } from "./web-read-state";
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
	const webReads = createWebReadPlan(ctx, ops);
	const action = guidedAction.parse(raw);
	const state = webReadState(get(db, t.id)!);
	if (action.mission) {
		if (
			state.mission &&
			JSON.stringify(state.mission) !== JSON.stringify(action.mission)
		)
			throw new Error("invalid_report");
		state.mission = action.mission;
		saveWebReadState(db, t.id, state);
	}
	if (!state.mission) throw new Error("invalid_report");
	if (action.action === "wait") webReads.wait(db, get(db, t.id)!);
	else if (action.action === "invoke") {
		const grant = input.grants.find(
			(g) => g.id === action.tool && !g.replayOnly,
		);
		const binding = (ctx.state.bindings.get(t.id) ?? []).find(
			(b) => b.executionRef === grant?.executionRef,
		);
		if (
			binding &&
			toolRuntimeOf(binding.tool.revisionId)?.operation === "read"
		) {
			const args = binding.tool.schemaKey === "read" ? action.arguments : null;
			if (
				!args ||
				typeof args.url !== "string" ||
				Object.keys(args).length !== 1
			)
				throw new Error("invalid_tool_input");
			webReads.select(db, get(db, t.id)!, {
				tool: action.tool,
				executionRef: binding.executionRef,
				stepId: input.stepId,
				jobId: claim.jobId,
				urls: [args.url, ...(action.readAhead ?? []).map((r) => r.url)],
			});
		} else {
			if (action.readAhead?.length) throw new Error("invalid_tool_input");
			invoke(action);
		}
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
