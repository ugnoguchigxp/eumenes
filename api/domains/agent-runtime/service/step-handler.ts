import { executionCallSession } from "../../tool-runtime";
import { z } from "zod";
import {} from "../../../infrastructure/validation-log";
import { type ProfileSnapshot } from "../../capabilities";
import type { HandlerDefinition } from "../../queue";
import { requirementVerification } from "../contracts/requirements";
import { get, update } from "../repository";
import { workerContext } from "./context";
import { parseControlOutput, safeCode } from "./control-output";
import { EvidenceCatalog } from "./evidence-catalog";
import { modelLimit, returnsSearchResults } from "./exploration";
import {
	researchAction,
	firstResearchAction,
	searchAction,
} from "./research-contract";
import { readRequirements } from "./requirements";
import { prepareRequirementVerification } from "./requirement-verification";
import { STEP_KIND, active, type RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import { createToolSelection } from "./tool-selection";
import { guidedWeb, guidedActionFor } from "./guided-contract";
import {
	activeExecutionChild,
	reservedExecutionCalls,
} from "./execution-children";
import type { ChildExecution } from "../../tool-runtime";
import {
	RESOURCE_READ_TOOL,
	allowedUris,
	type StoredRead,
} from "./resource-access";
import { parseResourceUri } from "../../resources";

import {
	createStepActions,
	type StepInput,
	type StepOutput,
} from "./step-actions";

export function createStepHandler(ctx: RuntimeContext, ops: TaskOps) {
	const { capabilities, tools, inference, queue, now } = ctx.deps;
	const { prepared, catalogs, bindings } = ctx.state;
	const { ready, fail, endSteps } = ops;
	const { rejectInvalidControl, applyAction, rejectAction } = createStepActions(
		ctx,
		ops,
	);
	const { usableTools } = createToolSelection({
		tools,
		bindings,
		prepared,
		now,
		resources: !!ctx.deps.resources,
	});
	/** The read a `resource.read` invocation asks for, made now because the host's port is async. */
	async function requestedRead(
		input: StepInput,
		action: unknown,
		signal: AbortSignal,
	): Promise<StoredRead | undefined> {
		const invoke = action as {
			action?: string;
			tool?: string;
			arguments?: { uri?: unknown };
		} | null;
		if (
			!ctx.deps.resources ||
			invoke?.action !== "invoke" ||
			invoke.tool !== RESOURCE_READ_TOOL ||
			!input.grants.some((g) => g.id === RESOURCE_READ_TOOL && !g.replayOnly)
		)
			return undefined;
		const parsed =
			typeof invoke.arguments?.uri === "string"
				? parseResourceUri(invoke.arguments.uri)
				: null;
		// An unlisted URI is never read; the action is then rejected as `unknown_resource` when it is applied.
		if (!parsed || !input.resourceUris.has(parsed.uri)) return undefined;
		try {
			return {
				uri: parsed.uri,
				...(await ctx.deps.resources.read(parsed.uri, signal)),
			};
		} catch (error) {
			return { uri: parsed.uri, ok: false, code: safeCode(error) };
		}
	}

	const handler: HandlerDefinition<
		{ taskId: string; stepId: string },
		StepInput,
		StepOutput
	> = {
		kind: STEP_KIND,
		payloadVersions: [1],
		schema: z.object({ taskId: z.string(), stepId: z.string() }),
		resourceKey: "inference.llm",
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const t = get(db, claim.payload.taskId);
			if (!t || t.state !== "queued" || t.job_id !== claim.jobId)
				return { status: "stale", reason: "task_not_queued" };
			const execution = JSON.parse(t.input_json ?? "{}").execution as
				| ChildExecution
				| undefined;
			if (
				execution &&
				(!activeExecutionChild(db, execution) ||
					t.model_calls + reservedExecutionCalls(db, t.id) >=
						execution.modelCalls)
			) {
				fail(db, t, "execution_budget_exhausted");
				return { status: "stale", reason: "execution_budget_exhausted" };
			}
			if (
				t.deadline <= now() ||
				t.model_calls >=
					(t.kind === "worker" ? modelLimit(prepared.get(t.id)) : 4)
			) {
				const code =
					t.phase === "verify_requirements"
						? "requirement_verification_unavailable"
						: "agent_budget_exhausted";
				fail(db, t, code);
				return { status: "stale", reason: code };
			}
			if (!inference.captureControlInTransaction || !inference.executeControl) {
				fail(db, t, "control_unavailable");
				return { status: "stale", reason: "control_unavailable" };
			}
			try {
				const p = prepared.get(t.id);
				if (!p || t.kind !== "worker")
					throw new Error("capability_ref_invalid");
				capabilities.validateInTransaction(db, p);
				const obs = tools.observationsInTransaction(db, t.id);
				const invocations = tools.invocationsInTransaction(db, t.id);
				// A replay must present the requested result again, even if newer results exist.
				const latest = obs.findIndex((o) => o.invocationId === t.invocation_id);
				if (latest >= 0) obs.push(...obs.splice(latest, 1));
				const guided = guidedWeb(p);
				const catalog = (
					catalogs.get(t.id) ?? new EvidenceCatalog(guided)
				).copy();
				const mode =
					t.phase === "verify_requirements"
						? "verify_requirements"
						: "research";
				const search = returnsSearchResults(p);
				const frozen = search ? null : readRequirements(db, t, capabilities);
				// After the first step the contract holds the profiles the sub-agent chose.
				const profiles = (frozen?.contract.profiles ??
					JSON.parse(t.input_json ?? "{}").requirementProfiles ??
					[]) as ProfileSnapshot[];
				capabilities.validateRequirementProfilesInTransaction(db, profiles);
				const context =
					mode === "verify_requirements"
						? prepareRequirementVerification(
								db,
								t,
								capabilities,
								tools,
								catalog,
								now(),
							)
						: workerContext(
								t,
								p,
								catalog.full ? [] : usableTools(db, t, true),
								obs.flatMap((o) => o.sources),
								obs.map((o) => ({
									tool: invocations
										.find((i) => i.id === o.invocationId)
										?.toolRevisionId.replace(/^tool:/, "")
										.replace(/@\d+$/, ""),
									arguments: invocations.find((i) => i.id === o.invocationId)
										?.arguments,
									state: o.state,
									errorCode: "errorCode" in o ? o.errorCode : null,
									failures: o.failures,
									notes: "notes" in o ? o.notes : null,
								})),
								catalog,
								now(),
								{ profiles, contract: frozen?.contract ?? null },
							);
				const capture = {
					subject: `agent:${t.id}:step:${t.current_step}`,
					policySubject: t.root_run_id,
					deadline: claim.deadlineAtMs ?? t.deadline,
					maxOutputTokens: 4096,
				};
				const requestId = execution
					? inference.captureUserControlInTransaction!(db, {
							subject: `execution-research:${t.id}-${t.current_step}`,
							route: "subagent",
							deadline: Math.min(capture.deadline, now() + 45_000),
							maxOutputTokens: capture.maxOutputTokens,
						})
					: inference.captureControlInTransaction(db, capture);
				const current = update(db, t, "running", t.phase);
				db.query(
					"UPDATE agent_tasks SET model_calls=model_calls+1 WHERE id=?",
				).run(t.id);
				db.query(
					"UPDATE agent_steps SET state='running',inference_request_id=?,manifest_digest=? WHERE id=? AND state='queued'",
				).run(requestId, context.manifestDigest, claim.payload.stepId);
				return {
					status: "ready",
					input: {
						catalog,
						mode,
						search,
						guided,
						first: !frozen,
						execution,
						taskId: t.id,
						stepId: claim.payload.stepId,
						revision: current.revision,
						requestId,
						messages: context.messages,
						control: "control" in context ? context.control : undefined,
						visible: context.visible ?? [],
						manifestDigest: context.manifestDigest,
						grants: context.grants,
						resourceUris: allowedUris(db, tools, t.id, execution),
					},
				};
			} catch (e) {
				fail(db, get(db, t.id)!, safeCode(e));
				return { status: "stale", reason: safeCode(e) };
			}
		},
		async execute(input, { signal }) {
			const receipt = await inference.executeControl!(
				input.requestId,
				input.messages,
				signal,
				input.control,
				input.execution
					? executionCallSession(input.execution)
					: { sessionRole: "subagent", taskId: input.taskId },
			);
			const output = parseControlOutput(receipt.value);
			const resourceRead = output.invalid
				? undefined
				: await requestedRead(input, output.action, signal);
			return { receipt, ...output, ...(resourceRead ? { resourceRead } : {}) };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const t = get(db, claim.payload.taskId);
			if (!active(t)) return "stale";
			if (outcome.type !== "success") {
				fail(
					db,
					t,
					outcome.type === "expired"
						? "deadline_exceeded"
						: outcome.type === "failed" ||
							  outcome.type === "retry" ||
							  outcome.type === "interrupted"
							? outcome.errorCode
							: "agent_failed",
				);
				return "applied";
			}
			if (!input || t.state !== "running" || t.revision !== input.revision)
				return "stale";
			const step = db
				.query(
					"SELECT state,manifest_digest FROM agent_steps WHERE id=? AND task_id=?",
				)
				.get(input.stepId, t.id) as {
				state: string;
				manifest_digest: string;
			} | null;
			if (
				step?.state !== "running" ||
				step.manifest_digest !== input.manifestDigest
			)
				return "stale";
			if (t.deadline <= now()) {
				fail(db, t, "deadline_exceeded");
				return "applied";
			}
			catalogs.set(t.id, input.catalog);
			if (
				(t.phase === "verify_requirements") !==
				(input.mode === "verify_requirements")
			)
				return "stale";
			const parsed = (
				input.mode === "verify_requirements"
					? requirementVerification
					: input.guided
						? guidedActionFor(prepared.get(t.id)!)
						: input.search
							? searchAction
							: input.first
								? firstResearchAction
								: researchAction
			).safeParse(outcome.result.action);
			if (outcome.result.invalid || !parsed.success) {
				rejectInvalidControl(db, t, claim, input, outcome, parsed);
				return "applied";
			}
			const action = parsed.data;
			db.exec("SAVEPOINT agent_action");
			try {
				applyAction(db, t, claim, input, outcome, action, parsed);
			} catch (e) {
				db.exec("ROLLBACK TO agent_action");
				db.exec("RELEASE agent_action");
				rejectAction(db, t, claim, input, outcome, action, e);
			}
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			const t = get(db, job.payload.taskId);
			if (active(t)) {
				endSteps(db, t.id, "cancelled", reason);
				update(db, t, "cancelled", "cancelled", reason);
				if (t.kind === "worker") {
					const parent = t.parent_task_id ? get(db, t.parent_task_id) : null;
					if (active(parent)) ready(db, parent, reason);
				}
			}
		},
	};
	queue.registerHandler(handler);
	return { handler };
}
