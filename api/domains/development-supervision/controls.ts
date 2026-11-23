import type { Database } from "bun:sqlite";
import { hash } from "../capabilities";
import type { ExecutionResponse } from "../tool-runtime";
import type { SupervisionBoardControl, SupervisionHost } from "./contracts";
import { revokeQuestions } from "./questions";
import { grantsOf, operationOf, saveOperation, saveParent } from "./repository";
import type { Parent, Task } from "./state";
import { finishTask } from "./views";
import { revokeGrant, workHold } from "./work";

export function startStop(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	cancelJob: (id: string | null) => void,
	reason: "cancelled" | "interrupted",
	forget = false,
) {
	if (parent.stop || (parent.phase === "finished" && !forget)) return;
	parent.stop = reason;
	parent.forgotten ||= forget;
	parent.generation++;
	cancelJob(parent.jobId);
	parent.jobId = null;
	for (const task of parent.tasks) {
		cancelJob(task.jobId);
		task.jobId = null;
		if (task.phase !== "finished") workHold(task, "停止確認中");
	}
	const all = grantsOf(db, parent.id);
	revokeQuestions(
		host,
		db,
		parent,
		new Set(all.map(({ source }) => source.delegation.grantRef)),
	);
	saveParent(db, parent, true);
	for (const grant of all) revokeGrant(host, db, grant);
	for (const design of parent.designs)
		if (!design.goal)
			host.design.cancelInTransaction(db, design.documentId, forget);
	if (forget)
		for (const notice of parent.notices)
			host.revokeInTransaction(db, notice.id);
}

export function operationReplay(
	db: Database,
	parent: Parent,
	input: { operationId: string },
	value: unknown,
) {
	const record = operationOf(db, input.operationId);
	if (!record) return false;
	if (record.parent_id !== parent.id || record.digest !== hash(value))
		throw new Error("operation_id_conflict");
	return true;
}

export function recordOperation(
	db: Database,
	parent: Parent,
	operationId: string,
	value: unknown,
) {
	saveOperation(db, operationId, parent.id, hash(value));
}

export function expectedControl(
	parent: Parent,
	input: Pick<
		SupervisionBoardControl,
		"expectedRevision" | "taskId" | "action"
	>,
) {
	const task = input.taskId
		? parent.tasks.find(({ id }) => id === input.taskId)
		: undefined;
	if (input.taskId && !task) throw new Error("supervision_task_unknown");
	if (input.action === "status") return task;
	if ((task?.revision ?? parent.revision) !== input.expectedRevision)
		throw new Error("execution_revision_conflict");
	if (parent.phase === "finished" || parent.stop || task?.phase === "finished")
		throw new Error("execution_terminal");
	return task;
}

export function amend(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	task: Task | undefined,
	text: string | undefined,
	cancelJob: (id: string | null) => void,
	source?: ExecutionResponse,
) {
	const request = text?.trim();
	if (
		!request ||
		request.length > 8_000 ||
		parent.controls.length >= 8 ||
		(task && parent.pendingTaskId && parent.pendingTaskId !== task.id)
	)
		throw new Error("supervision_amend_invalid");
	parent.controls.push({
		mode: "amend",
		text: request,
		taskId: task?.id ?? null,
		...(source ? { source } : {}),
	});
	cancelJob(parent.jobId);
	parent.jobId = null;
	parent.plan = null;
	parent.phase = "authority";
	parent.pendingTaskId = task?.id ?? null;
	parent.reason = "変更後の許可と作業範囲を確認中";
	const affected = grantsOf(db, parent.id).filter(
		({ source }) => !task || source.delegation.taskId === task.id,
	);
	if (task) {
		task.generation++;
		task.replanChangedInput = true;
		task.phase = "replan";
		cancelJob(task.jobId);
		task.jobId = null;
		workHold(task, "条件変更・旧実行の停止確認中");
	} else {
		parent.generation++;
		parent.ceiling = null;
		parent.research = [];
		parent.context = [];
		for (const task of parent.tasks) cancelJob(task.jobId);
		parent.tasks = [];
		for (const design of parent.designs)
			host.design.cancelInTransaction(db, design.documentId);
	}
	revokeQuestions(
		host,
		db,
		parent,
		new Set(affected.map(({ source }) => source.delegation.grantRef)),
	);
	saveParent(db, parent, true);
	for (const grant of affected) revokeGrant(host, db, grant);
}

export function stopTask(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	task: Task,
	cancelJob: (id: string | null) => void,
) {
	task.generation++;
	cancelJob(task.jobId);
	task.jobId = null;
	workHold(task, "取消・停止確認中");
	task.phase = "replan";
	task.result = {
		status: "cancelled",
		summary: "タスクの取消を受け付けました。",
		fulfilled: [],
		missing: [],
		refs: [],
	};
	if (parent.pendingTaskId === task.id) {
		cancelJob(parent.jobId);
		parent.jobId = null;
		parent.pendingTaskId = null;
		parent.phase = "active";
	}
	const affected = grantsOf(db, parent.id).filter(
		({ source }) => source.delegation.taskId === task.id,
	);
	revokeQuestions(
		host,
		db,
		parent,
		new Set(affected.map(({ source }) => source.delegation.grantRef)),
	);
	saveParent(db, parent, true);
	for (const grant of affected) revokeGrant(host, db, grant);
	if (affected.every(({ released }) => released))
		finishTask(task, "cancelled", "タスクを取り消しました。");
}
