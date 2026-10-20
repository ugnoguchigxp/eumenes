import type { Database } from "bun:sqlite";
import {
	scriptPublish,
	type ScriptBinding,
	type ScriptView,
} from "../contracts/script";
import { ownedTask, patchTask, type TaskRow } from "../repository";
import type { Ctx } from "./context";

export const scriptOf = (row: TaskRow): ScriptView | null =>
	row.script_json ? (JSON.parse(row.script_json) as ScriptView) : null;

/** The cursor is chosen by the model; the host binds each operation to that persisted revision. */
export function bindingOf(row: TaskRow): ScriptBinding | undefined {
	const script = scriptOf(row);
	const step = script?.steps.find((s) => s.state === "running");
	return script && step
		? { revision: script.revision, stepId: step.stepId }
		: undefined;
}

export function checkScript(task: TaskRow, binding?: ScriptBinding) {
	if (!task.script_required) return;
	const current = bindingOf(task);
	if (!current) throw new Error("script_not_ready");
	if (
		!binding ||
		current.revision !== binding.revision ||
		current.stepId !== binding.stepId
	)
		throw new Error("script_revision_conflict");
	// The transaction calling this check also records the operation, before any external dispatch.
}

export function publishScript(
	ctx: Ctx,
	db: Database,
	owner: string,
	taskId: string,
	epoch: number,
	raw: unknown,
) {
	const input = scriptPublish.parse(raw);
	const task = ownedTask(db, taskId, owner);
	if (
		task.state !== "running" ||
		task.epoch !== epoch ||
		task.deadline <= ctx.now()
	)
		throw new Error("task_not_active");
	const prior = scriptOf(task);
	if ((prior?.revision ?? 0) !== input.expectedRevision)
		throw new Error("script_revision_conflict");
	if ((prior?.revision ?? 0) >= 12) throw new Error("script_revision_limit");
	if (input.steps.filter((s) => s.state === "running").length > 1)
		throw new Error("script_multiple_active");
	const ids = new Set<string>();
	const steps = input.steps.map((step) => {
		const old = prior?.steps.find((s) => s.stepId === step.stepId);
		if (step.stepId && !old) throw new Error("script_step_not_found");
		const stepId = step.stepId ?? crypto.randomUUID();
		if (ids.has(stepId)) throw new Error("script_step_duplicate");
		ids.add(stepId);
		const unchangedComplete =
			old?.state === "completed" &&
			step.state === "completed" &&
			old.label === step.label &&
			old.expectation === step.expectation &&
			old.evidenceRef === step.evidenceRef;
		if (step.state === "completed" && !unchangedComplete) {
			const evidence = db
				.query(`SELECT o.ref FROM browser_observations o JOIN browser_tabs t ON t.tab_ref=o.tab_ref
			 WHERE o.ref=? AND o.task_id=? AND t.observation_ref=o.ref AND t.generation=o.generation AND t.status='open'`)
				.get(step.evidenceRef ?? "", taskId);
			if (!evidence) throw new Error("script_evidence_invalid");
		}
		return { ...step, stepId };
	});
	// Removed steps remain in the immutable earlier revision, never rewritten as completed.
	const revision = {
		revision: (prior?.revision ?? 0) + 1,
		summary: input.summary,
		steps,
		...(input.change ? { change: input.change } : {}),
		updatedAt: ctx.now(),
	};
	const { history: previousHistory = [], ...previousRevision } = prior ?? {};
	const history = prior
		? [...previousHistory, previousRevision as ScriptView["history"][number]]
		: [];
	const script: ScriptView = { ...revision, history };
	patchTask(db, taskId, { script_json: JSON.stringify(script) }, ctx.now());
	return script;
}
