import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { WorkTask } from "../contracts";
import * as repo from "../repository";
import type { TaskFence, TaskKindDefinition, TasksOptions } from "../types";
import { canonical, iso, receipt, syncHook, terminal } from "./helpers";

/** Shared invariants of every task command: fences, grants, event recording, idempotency. */
export function createTaskCore(options: TasksOptions) {
	const now = options.now ?? Date.now;
	const id = options.id ?? (() => crypto.randomUUID());
	const kinds = new Map<string, TaskKindDefinition>();
	for (const kind of options.kinds ?? []) {
		const key = `${kind.kind}.${kind.version}`;
		if (kinds.has(key)) throw new Error("invalid_duplicate_task_kind");
		kinds.set(key, kind);
	}
	const kindFor = (t: Pick<WorkTask, "kind" | "version">) =>
		kinds.get(`${t.kind}.${t.version}`);
	function requireTask(tx: Database, taskId: string) {
		const task = repo.get(tx, taskId);
		if (!task) throw new Error("task_not_found");
		return task;
	}
	function revision(t: WorkTask, expected: number) {
		if (t.revision !== expected) throw new Error("revision_conflict");
	}
	function currentGrant(t: WorkTask) {
		if (
			t.executionDeadlineAt !== null &&
			Date.parse(t.executionDeadlineAt) <= now()
		)
			throw new Error("task_runtime_expired");
		if (Date.parse(t.grant.expiresAt) <= now())
			throw new Error("task_grant_expired");
	}
	function fence(tx: Database, f: TaskFence, allowStopping = false) {
		const t = requireTask(tx, f.taskId);
		revision(t, f.expectedRevision);
		if (
			t.authorityEpoch !== f.authorityEpoch ||
			t.executionGeneration !== f.executionGeneration
		)
			throw new Error("task_fence_conflict");
		if (terminal(t.state) || (!allowStopping && t.state === "stopping"))
			throw new Error("task_state_conflict");
		if (!allowStopping) currentGrant(t);
		return t;
	}
	function record(tx: Database, t: WorkTask, reason: string) {
		if (!/^[a-z][a-z0-9_]{0,79}$/.test(reason))
			throw new Error("invalid_task_reason");
		t.revision++;
		t.eventSeq++;
		t.updatedAt = iso(now());
		if (terminal(t.state)) {
			t.finishedAt ??= t.updatedAt;
			const question = repo.openQuestion(tx, t.id);
			if (question) repo.putQuestion(tx, { ...question, state: "superseded" });
		}
		repo.put(tx, t);
		repo.recordEvent(tx, {
			seq: t.eventSeq,
			taskId: t.id,
			reason,
			state: t.state,
			phase: t.phase,
			revision: t.revision,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
			createdAt: t.updatedAt,
		});
		if (terminal(t.state)) syncHook(kindFor(t)?.terminalInTransaction?.(tx, t));
		syncHook(options.changedInTransaction?.(tx, t));
		return t;
	}
	function once(
		tx: Database,
		requestId: string,
		input: unknown,
		operation: () => WorkTask,
		admit: boolean | (() => boolean) = true,
	) {
		const digest = sha256Hex(canonical(input));
		const existing = repo.command(tx, "local", requestId);
		if (existing) {
			if (existing.digest !== digest) throw new Error("request_conflict");
			return existing.receipt;
		}
		const result = receipt(operation());
		repo.recordCommand(tx, "local", requestId, digest, result);
		if (typeof admit === "function" ? admit() : admit) requireStorage(tx);
		return result;
	}
	function requireStorage(tx: Database) {
		if (repo.capacity(tx).bytes > (options.maxStorageBytes ?? 32 * 1024 * 1024))
			throw new Error("task_capacity");
	}
	return {
		options,
		now,
		id,
		kindFor,
		requireTask,
		revision,
		currentGrant,
		fence,
		record,
		once,
		requireStorage,
	};
}
export type TaskCore = ReturnType<typeof createTaskCore>;
