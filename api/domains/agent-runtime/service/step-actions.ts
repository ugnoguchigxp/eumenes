import { z } from "zod";
import type { LogFields } from "../../../infrastructure/logger";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import { researchInput, toolRuntimeOf } from "../../capabilities";
import type { Receipt, ControlContract } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
import { requirementVerification } from "../contracts/requirements";
import { get, byRoot, update } from "../repository";
import { safeCode } from "./control-output";
import type { EvidenceCatalog } from "./evidence-catalog";
import {
	isHistory,
	isSearch,
	isPageRead,
	explorationBudget,
	modelLimit,
} from "./exploration";
import { logRejection } from "./rejection-log";
import {
	researchAction,
	firstResearchAction,
	searchAction,
} from "./research-contract";
import { saveSearchReport } from "./search-report";
import {
	freezeRequirements,
	readRequirements,
	validateDraft,
	saveDraft,
	draftReferences,
} from "./requirements";
import { acceptRequirementVerification } from "./requirement-verification";
import { owner, active, type RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import { guidedAction, guidedWeb } from "./guided-contract";
import { applyGuidedAction } from "./guided-step";

export type StepInput = {
	catalog: EvidenceCatalog;
	mode: "research" | "verify_requirements";
	search: boolean;
	guided?: boolean;
	first: boolean;
	taskId: string;
	stepId: string;
	revision: number;
	requestId: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	control?: ControlContract;
	visible: Source[];
	manifestDigest: string;
	grants: Array<{ id: string; executionRef: string; replayOnly?: boolean }>;
};
export type StepOutput = {
	receipt: Receipt;
	action: unknown;
	invalid: boolean;
	diagnostic?: LogFields;
};
type StepHandler = HandlerDefinition<
	{ taskId: string; stepId: string },
	StepInput,
	StepOutput
>;
export type Tx = Parameters<StepHandler["settleInTransaction"]>[0];
export type Claim = Parameters<StepHandler["settleInTransaction"]>[1];
type ControlAction =
	| z.infer<typeof guidedAction>
	| z.infer<typeof requirementVerification>
	| z.infer<typeof firstResearchAction>
	| z.infer<typeof searchAction>
	| z.infer<typeof researchAction>;
/** Keeps one entry per path/code; only sanitized diagnostics are stored. */
function saveRepair(db: Tx, taskId: string, issues: LogFields[]) {
	const seen = new Set<string>();
	const unique = issues.filter((issue) => {
		const key = `${issue.validationPath ?? ""}:${issue.validationCode ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	db.query("UPDATE agent_tasks SET control_repair_json=? WHERE id=?").run(
		JSON.stringify(unique),
		taskId,
	);
}
/** Invokes the granted tool for this step; authority was fixed at prepare. */
function invokeStepTool(
	ctx: RuntimeContext,
	ops: TaskOps,
	db: Tx,
	t: Task,
	claim: Claim,
	input: StepInput,
	p: NonNullable<ReturnType<RuntimeContext["state"]["prepared"]["get"]>>,
	action: Extract<ControlAction, { action: "invoke" }>,
) {
	const { tools } = ctx.deps;
	const { catalogs, bindings } = ctx.state;
	// Authority at prepare is immutable for this step. Cancellation,
	// registry revision and the hard deadline are still checked at invoke.
	const grant = input.grants.find((g) => g.id === action.tool);
	const tool = (bindings.get(t.id) ?? []).find(
		(b) => b.executionRef === grant?.executionRef,
	);
	if (!tool)
		throw new ValidationFailure("invalid_tool_input", [
			{ validationPath: "tool", validationCode: "unknown_tool" },
		]);
	if (isHistory(p) && toolRuntimeOf(tool.tool.revisionId)?.cursorPaging) {
		const stale = tools
			.observationsInTransaction(db, t.id)
			.filter(
				(o) => "errorCode" in o && o.errorCode === "history_cursor_stale",
			).length;
		if (stale > 1) throw new Error("agent_budget_exhausted");
	}
	const taskInput = researchInput.parse(p.input);
	const obs = tools.observationsInTransaction(db, t.id);
	const urls = [
		...(taskInput.urls ?? []),
		...obs.flatMap((o) => o.sources.flatMap((s) => (s.url ? [s.url] : []))),
	];
	const calls = [
		action.arguments,
		...("readAhead" in action ? (action.readAhead ?? []) : []),
	];
	if (calls.length > 1 && !isPageRead(toolRuntimeOf(tool.tool.revisionId)))
		throw new Error("invalid_tool_input");
	let lastId = "";
	for (const [index, args] of calls.entries()) {
		const budget = explorationBudget(
			t,
			p,
			tools.invocationsInTransaction(db, t.id),
			ctx.deps.now(),
		);
		if (
			calls.length > 1 &&
			(!budget.canOperate ||
				budget.reads >= budget.maxReads ||
				budget.externalCalls >= budget.maxExternalCalls)
		)
			throw new Error("invalid_tool_input");
		const inv = tools.invokeInTransaction(
			db,
			owner(t),
			tool.executionRef,
			catalogs.get(t.id)!.arguments(args),
			calls.length === 1 ? input.stepId : `${input.stepId}:${index}`,
			t.deadline,
			claim.jobId,
			urls,
			taskInput.question,
			!grant?.replayOnly,
		);
		lastId = inv.id;
	}
	db.query(
		"UPDATE agent_tasks SET tool_calls=?,invocation_id=? WHERE id=?",
	).run(tools.invocationsInTransaction(db, t.id).length, lastId, t.id);
	update(
		db,
		get(db, t.id)!,
		"running",
		isSearch(toolRuntimeOf(tool.tool.revisionId)) ? "search" : "read",
	);
	ops.waitForTools(db, get(db, t.id)!, claim.jobId);
}
export function createStepActions(ctx: RuntimeContext, ops: TaskOps) {
	const { store, capabilities, tools, inference, now } = ctx.deps;
	const { prepared, catalogs, releases } = ctx.state;
	const { enqueue, ready, fail, next } = ops;
	function rejectInvalidControl(
		db: Tx,
		t: Task,
		claim: Claim,
		input: StepInput,
		outcome: { result: StepOutput },
		parsed: z.ZodSafeParseResult<ControlAction>,
	) {
		const issues =
			!outcome.result.invalid && !parsed.success
				? validationIssues(parsed.error, outcome.result.action)
				: [
						{
							validationCode:
								outcome.result.diagnostic?.validationCode ??
								"invalid_json_syntax",
						},
					];
		if (!parsed.success)
			for (const issue of parsed.error.issues) {
				if (issue.code === "unrecognized_keys")
					for (const key of issue.keys) {
						if (
							[
								"requirements",
								"checks",
								"externalRules",
								"report",
								"arguments",
								"tool",
							].includes(key)
						)
							issues.push({
								validationPath: key,
								validationCode: "unrecognized_keys",
							});
					}
			}
		saveRepair(db, t.id, issues);
		logRejection(
			store,
			t,
			input,
			outcome.result,
			claim.jobId,
			"invalid_control_json",
			{
				reason: outcome.result.invalid
					? (outcome.result.diagnostic?.reason ?? "control_json_syntax")
					: "control_schema_invalid",
			},
			issues,
			!outcome.result.invalid && !parsed.success
				? parsed.error.issues.length
				: 0,
		);
		inference.rejectControlInTransaction?.(
			db,
			outcome.result.receipt,
			"invalid_control_json",
		);
		db.query(
			"UPDATE agent_steps SET state='rejected',error_code='invalid_control_json' WHERE id=?",
		).run(input.stepId);
		if (t.json_repairs >= 1) fail(db, t, "invalid_control_json");
		else {
			db.query(
				"UPDATE agent_tasks SET json_repairs=json_repairs+1 WHERE id=?",
			).run(t.id);
			next(db, get(db, t.id)!, claim.jobId, "invalid_control_json");
		}
		return "applied";
	}
	function applyAction(
		db: Tx,
		t: Task,
		claim: Claim,
		input: StepInput,
		outcome: { result: StepOutput },
		action: ControlAction,
		parsed: { data: ControlAction },
	) {
		const p = prepared.get(t.id);
		if (!p) throw new Error("capability_ref_invalid");
		capabilities.validateInTransaction(db, p);
		const root = byRoot(db, t.root_run_id);
		if (
			!active(root) ||
			root.state !== "waiting_child" ||
			root.id !== t.parent_task_id
		)
			throw new Error("task_cancelled");
		if (input.mode === "verify_requirements") {
			const verification = requirementVerification.parse(action);
			acceptRequirementVerification(
				db,
				t,
				capabilities,
				tools,
				input.catalog,
				input,
				verification,
				now(),
			);
			db.query(
				"UPDATE agent_tasks SET report_state='available' WHERE id=?",
			).run(t.id);
			update(db, get(db, t.id)!, "completed", "completed");
			ready(db, root, null, t.id);
			releases.add(t.id);
		} else if (guidedWeb(p)) {
			applyGuidedAction(
				ctx,
				ops,
				db,
				t,
				root,
				claim,
				input,
				p,
				parsed.data,
				(action) => invokeStepTool(ctx, ops, db, t, claim, input, p, action),
			);
		} else {
			const research = (
				input.search
					? searchAction
					: input.first
						? firstResearchAction
						: researchAction
			).parse(parsed.data);
			if (!input.search && input.first) {
				const first = firstResearchAction.parse(parsed.data);
				freezeRequirements(
					db,
					t,
					first.requirements,
					capabilities,
					now(),
					first.requirementProfiles ?? [],
				);
			}
			const frozen = input.search
				? null
				: readRequirements(db, t, capabilities);
			if (!input.search && !frozen) throw new Error("required_context_missing");
			const action = research;
			// Giving up before any acquisition while a tool is still invocable is a
			// contract violation, not a result: the model gets its one repair to invoke.
			if (
				action.action === "finish" &&
				["failed", "not_found"].includes(
					(action.report as { outcome?: string }).outcome ?? "",
				) &&
				input.grants.some((g) => !g.replayOnly) &&
				!tools
					.invocationsInTransaction(db, t.id)
					.some((i) => toolRuntimeOf(i.toolRevisionId)?.operation !== "recipe")
			)
				throw new ValidationFailure("invalid_report", [
					{
						validationPath: "action",
						validationCode: "invoke_required_before_finish",
					},
				]);
			if (action.action === "invoke") {
				invokeStepTool(ctx, ops, db, t, claim, input, p, action);
			} else if (input.search) {
				saveSearchReport(db, t, action.report, input.catalog, tools, now(), {
					hook: ctx.deps.onSearchReport,
					packageId: prepared.get(t.id)?.package.id,
				});
				db.query(
					"UPDATE agent_tasks SET report_state='available' WHERE id=?",
				).run(t.id);
				update(db, get(db, t.id)!, "completed", "completed");
				ready(db, root, null, t.id);
				releases.add(t.id);
			} else if (action.action === "finish") {
				const draft = validateDraft(action.report, frozen!.contract);
				const catalog = catalogs.get(t.id)!;
				catalog.verificationEvidence(draftReferences(draft));
				if (
					!tools.validateEvidenceInTransaction(
						db,
						owner(t),
						catalog.referencedSources(draftReferences(draft)),
					)
				)
					throw new Error("evidence_invalidated");
				if (t.model_calls >= modelLimit(p) || t.deadline <= now())
					throw new Error("requirement_verification_unavailable");
				saveDraft(db, t, frozen!.digest, draft, now());
				update(db, get(db, t.id)!, "queued", "verify_requirements");
				enqueue(db, get(db, t.id)!, claim.jobId);
			}
		}

		db.query("UPDATE agent_tasks SET control_repair_json=NULL WHERE id=?").run(
			t.id,
		);
		if (!inference.acceptInTransaction?.(db, outcome.result.receipt))
			throw new Error("permission_revoked");
		db.query(
			"UPDATE agent_steps SET state='completed',action_kind=? WHERE id=?",
		).run(
			"action" in action ? action.action : "verify_requirements",
			input.stepId,
		);
		db.exec("RELEASE agent_action");
	}
	function rejectAction(
		db: Tx,
		t: Task,
		claim: Claim,
		input: StepInput,
		outcome: { result: StepOutput },
		action: ControlAction,
		e: unknown,
	) {
		const code = safeCode(e);
		saveRepair(
			db,
			t.id,
			e instanceof ValidationFailure ? e.issues : [{ validationCode: code }],
		);
		logRejection(
			store,
			t,
			input,
			outcome.result,
			claim.jobId,
			code,
			{
				reason: code,
				controlAction:
					"action" in action ? action.action : "verify_requirements",
			},
			e instanceof ValidationFailure ? e.issues : [],
			e instanceof ValidationFailure ? e.issueCount : 0,
			e,
		);
		inference.rejectControlInTransaction?.(db, outcome.result.receipt, code);
		if (
			([
				"invalid_tool_input",
				"invalid_evidence",
				"invalid_report",
				"invalid_requirement_report",
				"invalid_requirement_contract",
				"invalid_requirement_schema",
				"invalid_requirement_verification",
			].includes(code) ||
				code === "tool_url_out_of_scope") &&
			t.kind === "worker" &&
			t.json_repairs < 1
		) {
			db.query(
				"UPDATE agent_tasks SET json_repairs=json_repairs+1 WHERE id=?",
			).run(t.id);
			db.query(
				"UPDATE agent_steps SET state='rejected',error_code=? WHERE id=?",
			).run(code, input.stepId);
			next(db, get(db, t.id)!, claim.jobId, code);
		} else fail(db, get(db, t.id)!, code);
	}
	return { rejectInvalidControl, applyAction, rejectAction };
}
