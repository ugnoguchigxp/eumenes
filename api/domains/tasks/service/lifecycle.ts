import type { Database } from "bun:sqlite";
import {
	createTaskSchema,
	workTaskSchema,
	stopTaskSchema,
	taskCommandSchema,
	taskOriginSchema,
	type CreateTask,
	type WorkTask,
} from "../contracts";
import * as repo from "../repository";
import type { TaskFence, TrustedTaskContext } from "../types";
import type { TaskCore } from "./core";
import { canonical, iso, manual, receipt, syncHook, terminal } from "./helpers";

/** Registration, start, stop and forget: the commands that move a task between lifecycle states. */
export function createTaskLifecycle(core: TaskCore) {
	const {
		now,
		id,
		options,
		kindFor,
		requireTask,
		revision,
		currentGrant,
		fence,
		record,
		once,
	} = core;
	function startTask(tx: Database, t: WorkTask) {
		currentGrant(t);
		const kind = kindFor(t);
		if (kind?.available() !== true)
			throw new Error("task_execution_unavailable");
		if (!["registered", "paused"].includes(t.state))
			throw new Error("task_state_conflict");
		t.executionGeneration++;
		t.executionDeadlineAt ??= iso(now() + t.grant.maxRuntimeMs);
		t.state = "queued";
		t.stopIntent = null;
		if (t.kind === "coding") t.phase ??= "preparing";
		record(tx, t, "start_requested");
		syncHook(kind.startInTransaction(tx, t));
		return t;
	}
	function createInTransaction(
		tx: Database,
		input: CreateTask,
		context: TrustedTaskContext = manual,
	) {
		const parsed = createTaskSchema.safeParse(input);
		const origin = taskOriginSchema.safeParse(context.origin);
		if (!parsed.success || !origin.success)
			throw new Error("invalid_task_input");
		const data = parsed.data;
		return once(
			tx,
			data.requestId,
			{ op: "create", data, origin: origin.data },
			() => {
				const key =
					origin.data.source === "conversation"
						? canonical([
								origin.data.conversationId,
								origin.data.messageId,
								origin.data.operationKey,
							])
						: null;
				if (key && repo.byOrigin(tx, key))
					throw new Error("task_origin_conflict");
				const capacity = repo.capacity(tx);
				if (
					capacity.live >= (options.maxLiveTasks ?? 256) ||
					capacity.total >= (options.maxTasks ?? 4096) ||
					capacity.bytes +
						new TextEncoder().encode(canonical(data)).length * 2 >
						(options.maxStorageBytes ?? 32 * 1024 * 1024)
				)
					throw new Error("task_capacity");
				const at = iso(now());
				const t = workTaskSchema.parse({
					id: id(),
					kind: data.kind,
					version: data.version,
					title: data.title,
					request: data.request,
					completionConditions: data.completionConditions,
					origin: origin.data,
					state: "registered",
					phase: null,
					revision: 0,
					authorityEpoch: 1,
					executionGeneration: 0,
					eventSeq: 0,
					grant: data.grant,
					stopIntent: null,
					result: null,
					bodyExpired: false,
					metadataExpired: false,
					forgottenAt: null,
					executionDeadlineAt: null,
					createdAt: at,
					updatedAt: at,
					finishedAt: null,
				});
				currentGrant(t);
				repo.insert(tx, t, key);
				repo.grant(tx, t, origin.data);
				record(tx, t, "registered");
				if (data.startMode === "start") startTask(tx, t);
				return t;
			},
		);
	}
	function requestStartInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
	) {
		const parsed = taskCommandSchema.safeParse(input);
		if (!parsed.success) throw new Error("invalid_task_input");
		return once(
			tx,
			parsed.data.requestId,
			{ op: "start", taskId, ...parsed.data },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				return startTask(tx, t);
			},
		);
	}
	function settleStopInTransaction(tx: Database, f: TaskFence) {
		const t = fence(tx, f, true);
		if (t.state !== "stopping") throw new Error("task_state_conflict");
		if (
			Date.parse(t.grant.expiresAt) <= now() ||
			(t.executionDeadlineAt !== null &&
				Date.parse(t.executionDeadlineAt) <= now())
		)
			t.stopIntent = "cancel";
		t.state = t.stopIntent === "pause" ? "paused" : "cancelled";
		return receipt(record(tx, t, "stop_confirmed"));
	}
	function stopTask(
		tx: Database,
		t: WorkTask,
		intent: "pause" | "cancel",
		reason: string,
	) {
		if (terminal(t.state)) throw new Error("task_state_conflict");
		const executionStopped =
			t.state === "paused" || t.executionGeneration === 0;
		if (
			t.state === "stopping" &&
			t.stopIntent === "cancel" &&
			intent === "pause"
		)
			throw new Error("task_state_conflict");
		t.authorityEpoch++;
		t.state = "stopping";
		t.stopIntent = intent;
		const q = repo.openQuestion(tx, t.id);
		if (q) repo.putQuestion(tx, { ...q, state: "superseded" });
		record(tx, t, reason);
		syncHook(kindFor(t)?.stopInTransaction(tx, t, { executionStopped }));
		return t;
	}
	function requestStopInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
	) {
		const parsed = stopTaskSchema.safeParse(input);
		if (!parsed.success) throw new Error("invalid_task_input");
		let alreadyStopped = false;
		const accepted = once(
			tx,
			parsed.data.requestId,
			{ op: "stop", taskId, ...parsed.data },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				alreadyStopped = t.state === "paused";
				return stopTask(tx, t, parsed.data.intent, "stop_requested");
			},
			false,
		);
		const t = requireTask(tx, taskId);
		// A never-started task has no external execution to reconcile.
		if (
			(t.executionGeneration === 0 || alreadyStopped) &&
			t.state === "stopping"
		)
			settleStopInTransaction(tx, {
				taskId,
				expectedRevision: t.revision,
				authorityEpoch: t.authorityEpoch,
				executionGeneration: t.executionGeneration,
			});
		return accepted;
	}
	function forgetInTransaction(tx: Database, taskId: string, input: unknown) {
		const parsed = taskCommandSchema.safeParse(input);
		if (!parsed.success) throw new Error("invalid_task_input");
		let alreadyStopped = false;
		const accepted = once(
			tx,
			parsed.data.requestId,
			{ op: "forget", taskId, ...parsed.data },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				alreadyStopped = t.state === "paused" || t.executionGeneration === 0;
				if (!terminal(t.state)) stopTask(tx, t, "cancel", "forget_requested");
				t.request = null;
				t.title = "削除済みタスク";
				t.completionConditions = [];
				t.origin = { source: "manual" };
				t.bodyExpired = true;
				t.forgottenAt = iso(now());
				if (t.result)
					t.result = {
						...t.result,
						summary: "履歴を削除しました",
						conditionsMet: [],
					};
				repo.clearPrivateHistory(tx, taskId);
				repo.detachConversation(tx, taskId);
				return record(tx, t, "forgotten");
			},
			false,
		);
		const t = requireTask(tx, taskId);
		if (alreadyStopped && t.state === "stopping")
			settleStopInTransaction(tx, {
				taskId,
				expectedRevision: t.revision,
				authorityEpoch: t.authorityEpoch,
				executionGeneration: t.executionGeneration,
			});
		return accepted;
	}
	return {
		createInTransaction,
		requestStartInTransaction,
		requestStopInTransaction,
		forgetInTransaction,
		settleStopInTransaction,
		stopTask,
	};
}
