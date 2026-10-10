import { z } from "zod";
import type { LogFields } from "../../../infrastructure/logger";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import { researchInput, toolRuntimeOf } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
import { requirementVerification } from "../contracts/requirements";
import { get, byRoot, update } from "../repository";
import { safeCode } from "./control-output";
import type { EvidenceCatalog } from "./evidence-catalog";
import { isHistory, isSearch, modelLimit } from "./exploration";
import { logRejection } from "./rejection-log";
import { researchAction, firstResearchAction } from "./research-contract";
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

export type StepInput = {
	catalog: EvidenceCatalog;
	mode: "research" | "verify_requirements";
	first: boolean;
	taskId: string;
	stepId: string;
	revision: number;
	requestId: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
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
	| z.infer<typeof requirementVerification>
	| z.infer<typeof firstResearchAction>
	| z.infer<typeof researchAction>;
export function createStepActions(ctx: RuntimeContext, ops: TaskOps) {
	const { store, capabilities, tools, inference, now } = ctx.deps;
	const { prepared, catalogs, bindings, releases } = ctx.state;
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
				: [];
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
		} else {
			const research = (
				input.first ? firstResearchAction : researchAction
			).parse(parsed.data);
			if (input.first)
				freezeRequirements(
					db,
					t,
					firstResearchAction.parse(parsed.data).requirements,
					capabilities,
					now(),
				);
			const frozen = readRequirements(db, t, capabilities);
			if (!frozen) throw new Error("required_context_missing");
			const action = research;
			if (action.action === "invoke") {
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
					...obs.flatMap((o) =>
						o.sources.flatMap((s) => (s.url ? [s.url] : [])),
					),
				];
				const inv = tools.invokeInTransaction(
					db,
					owner(t),
					tool.executionRef,
					catalogs.get(t.id)!.arguments(action.arguments),
					input.stepId,
					t.deadline,
					claim.jobId,
					urls,
					taskInput.question,
					!grant?.replayOnly,
				);
				db.query(
					"UPDATE agent_tasks SET tool_calls=?,invocation_id=? WHERE id=?",
				).run(tools.invocationsInTransaction(db, t.id).length, inv.id, t.id);
				if (inv.state !== "pending") {
					next(db, get(db, t.id)!, claim.jobId, "research_no_progress");
				} else
					update(
						db,
						get(db, t.id)!,
						"waiting_tool",
						isSearch(toolRuntimeOf(tool.tool.revisionId)) ? "search" : "read",
					);
			} else if (action.action === "finish") {
				const draft = validateDraft(action.report, frozen.contract);
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
				saveDraft(db, t, frozen.digest, draft, now());
				update(db, get(db, t.id)!, "queued", "verify_requirements");
				enqueue(db, get(db, t.id)!, claim.jobId);
			}
		}

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
