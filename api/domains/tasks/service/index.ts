import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	answerTaskSchema,
	amendTaskSchema,
	codingPhases,
	createTaskSchema,
	stopTaskSchema,
	taskCommandSchema,
	taskOriginSchema,
	taskQuestionInputSchema,
	taskResultSchema,
	type CreateTask,
	type TaskGrant,
	type TaskOrigin,
	type TaskReceipt,
	type TaskQuestion,
	type TaskQuestionInput,
	type WorkTask,
} from "../contracts";
import * as repo from "../repository";
import type {
	TaskFence,
	TaskKindDefinition,
	TasksOptions,
	TrustedTaskContext,
} from "../types";

const terminal = (s: WorkTask["state"]) =>
	["completed", "failed", "cancelled"].includes(s);
const iso = (ms: number) => new Date(ms).toISOString();
function syncHook(value: unknown) {
	if (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	) {
		void Promise.resolve(value).catch(() => {});
		throw new Error("invalid_async_transaction_callback");
	}
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
const receipt = (t: WorkTask): TaskReceipt => ({
	taskId: t.id,
	state: t.state,
	revision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});
const transitions: Partial<Record<WorkTask["state"], WorkTask["state"][]>> = {
	queued: ["active", "reconciling", "failed"],
	active: ["active", "waiting_user", "reconciling", "completed", "failed"],
	reconciling: ["active", "waiting_user", "completed", "failed"],
};
const manual: TrustedTaskContext = { origin: { source: "manual" } };

export function createTasks(store: SqliteStore, options: TasksOptions = {}) {
	const log = getLogger("tasks");
	async function writeCommand(
		operation: (tx: Database) => TaskReceipt,
		event: string,
	) {
		const result = await store.write(operation);
		log.info(event, {
			workTaskId: result.taskId,
			status: result.state,
			generation: result.executionGeneration,
		});
		return result;
	}
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
		return t;
	}
	function once(
		tx: Database,
		requestId: string,
		input: unknown,
		operation: () => WorkTask,
		admit: boolean | (() => boolean) = true,
	) {
		const digest = new Bun.CryptoHasher("sha256")
			.update(canonical(input))
			.digest("hex");
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
		t.phase ??= "preparing";
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
				const t: WorkTask = {
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
				};
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
	function amendGrantInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
		context: TrustedTaskContext = manual,
	) {
		const parsed = amendTaskSchema.safeParse(input);
		if (!parsed.success || !taskOriginSchema.safeParse(context.origin).success)
			throw new Error("invalid_task_input");
		let restriction = false;
		return once(
			tx,
			parsed.data.requestId,
			{ op: "amend", taskId, ...parsed.data, origin: context.origin },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				if (terminal(t.state) || ["stopping", "reconciling"].includes(t.state))
					throw new Error("task_state_conflict");
				const previous = structuredClone(t);
				const before = t.grant,
					after = parsed.data.grant;
				restriction =
					after.workspaceId === before.workspaceId &&
					after.branch === before.branch &&
					after.remote === before.remote &&
					after.operations.every((op) => before.operations.includes(op)) &&
					(after.network === before.network || after.network === "none") &&
					Date.parse(after.expiresAt) <= Date.parse(before.expiresAt) &&
					after.maxRuntimeMs <= before.maxRuntimeMs &&
					after.maxDecisions <= before.maxDecisions &&
					(after.operations.length < before.operations.length ||
						after.network !== before.network ||
						Date.parse(after.expiresAt) < Date.parse(before.expiresAt) ||
						after.maxRuntimeMs < before.maxRuntimeMs ||
						after.maxDecisions < before.maxDecisions);
				if (t.executionDeadlineAt !== null) {
					const deadline = Date.parse(t.executionDeadlineAt);
					if (deadline <= now()) throw new Error("task_runtime_expired");
					// Only an explicit grant change adjusts the budget, anchored to the first start.
					t.executionDeadlineAt = iso(
						deadline + parsed.data.grant.maxRuntimeMs - t.grant.maxRuntimeMs,
					);
				}
				t.grant = parsed.data.grant;
				if (Date.parse(t.grant.expiresAt) <= now())
					throw new Error("task_grant_expired");
				const budgetExpired =
					t.executionDeadlineAt !== null &&
					Date.parse(t.executionDeadlineAt) <= now();
				t.authorityEpoch++;
				repo.grant(tx, t, context.origin);
				const q = repo.openQuestion(tx, taskId);
				if (q) repo.putQuestion(tx, { ...q, state: "superseded" });
				if (
					budgetExpired ||
					["queued", "active", "waiting_user"].includes(t.state)
				) {
					t.state = "stopping";
					t.stopIntent = budgetExpired ? "cancel" : "pause";
				}
				record(tx, t, "grant_amended");
				syncHook(kindFor(t)?.amendInTransaction?.(tx, previous, t));
				if (t.state === "stopping") {
					const executionStopped =
						previous.state === "paused" || t.executionGeneration === 0;
					syncHook(kindFor(t)?.stopInTransaction(tx, t, { executionStopped }));
					if (executionStopped)
						settleStopInTransaction(tx, {
							taskId: t.id,
							expectedRevision: t.revision,
							authorityEpoch: t.authorityEpoch,
							executionGeneration: t.executionGeneration,
						});
				}
				return requireTask(tx, t.id);
			},
			() => !restriction,
		);
	}
	function applyTransitionInTransaction(
		tx: Database,
		f: TaskFence,
		input: {
			state: WorkTask["state"];
			phase?: WorkTask["phase"];
			reason: string;
			result?: unknown;
		},
	) {
		const t = fence(tx, f);
		if (
			!transitions[t.state]?.includes(input.state) ||
			input.state === "waiting_user"
		)
			throw new Error("task_state_conflict");
		if (
			input.phase !== undefined &&
			input.phase !== null &&
			!codingPhases.includes(input.phase)
		)
			throw new Error("invalid_task_phase");
		if (input.state === "completed" || input.state === "failed") {
			const result = taskResultSchema.safeParse(input.result);
			if (
				!result.success ||
				(input.state === "completed" &&
					(result.data.conditionsMet.length !== t.completionConditions.length ||
						!result.data.conditionsMet.every(Boolean)))
			)
				throw new Error("invalid_task_result");
			t.result = result.data;
		} else if (input.result !== undefined)
			throw new Error("invalid_task_result");
		t.state = input.state;
		if (input.phase !== undefined) t.phase = input.phase;
		const accepted = receipt(record(tx, t, input.reason));
		if (!terminal(t.state) && t.state !== "reconciling") requireStorage(tx);
		return accepted;
	}
	function askInTransaction(
		tx: Database,
		f: TaskFence,
		input: TaskQuestionInput,
	) {
		const parsed = taskQuestionInputSchema.safeParse(input);
		if (!parsed.success) throw new Error("invalid_task_question");
		const data = parsed.data;
		const t = fence(tx, f);
		if (!["active", "reconciling"].includes(t.state))
			throw new Error("task_state_conflict");
		if (repo.question(tx, data.questionId) || repo.openQuestion(tx, t.id))
			throw new Error("task_question_conflict");
		t.state = "waiting_user";
		record(tx, t, "question_opened");
		const q: TaskQuestion = {
			id: data.questionId,
			taskId: t.id,
			prompt: data.prompt,
			answerType: data.answerType,
			choices: data.choices,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
			state: "open",
			answer: null,
			answeredFrom: null,
			createdAt: iso(now()),
		};
		repo.putQuestion(tx, q);
		requireStorage(tx);
		return receipt(t);
	}
	function answerInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
		context: TrustedTaskContext = manual,
	) {
		const parsed = answerTaskSchema.safeParse(input);
		if (!parsed.success || !taskOriginSchema.safeParse(context.origin).success)
			throw new Error("invalid_task_input");
		return once(
			tx,
			parsed.data.requestId,
			{ op: "answer", taskId, ...parsed.data, origin: context.origin },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				currentGrant(t);
				const q = repo.question(tx, parsed.data.questionId);
				if (
					t.state !== "waiting_user" ||
					!q ||
					q.taskId !== t.id ||
					q.state !== "open" ||
					q.authorityEpoch !== t.authorityEpoch ||
					q.executionGeneration !== t.executionGeneration
				)
					throw new Error("task_question_conflict");
				if (
					q.answerType === "choice" &&
					!q.choices.includes(parsed.data.answer)
				)
					throw new Error("invalid_task_answer");
				const kind = kindFor(t);
				if (!kind?.available() || !kind.answerInTransaction)
					throw new Error("task_execution_unavailable");
				repo.putQuestion(tx, {
					...q,
					state: "answered",
					answer: parsed.data.answer,
					answeredFrom: context.origin,
				});
				t.state = "queued";
				record(tx, t, "question_answered");
				syncHook(kind.answerInTransaction(tx, t, q.id));
				return t;
			},
		);
	}
	function cleanupInTransaction(tx: Database) {
		let expired = 0;
		for (const t of repo.expiredBodies(tx, now() - 7 * 86_400_000, 100)) {
			t.request = null;
			t.completionConditions = [];
			t.bodyExpired = true;
			repo.clearPrivateHistory(tx, t.id);
			record(tx, t, "body_expired");
			expired++;
		}
		for (const t of repo.expiredMetadata(tx, now() - 30 * 86_400_000)) {
			t.metadataExpired = true;
			record(tx, t, "metadata_expired");
			repo.clearRuntimeHistory(tx, t);
		}
		return expired;
	}
	function maintenanceInTransaction(tx: Database) {
		for (const t of repo.live(tx)) {
			const expired =
				Date.parse(t.grant.expiresAt) <= now() ||
				(t.executionDeadlineAt !== null &&
					Date.parse(t.executionDeadlineAt) <= now());
			if (t.state === "stopping" && !(t.stopIntent === "pause" && expired))
				syncHook(kindFor(t)?.stopInTransaction(tx, t));
			else if (expired) {
				const executionStopped =
					t.state === "paused" || t.executionGeneration === 0;
				stopTask(
					tx,
					t,
					"cancel",
					Date.parse(t.grant.expiresAt) <= now()
						? "grant_expired"
						: "runtime_budget_expired",
				);
				if (executionStopped)
					settleStopInTransaction(tx, {
						taskId: t.id,
						expectedRevision: t.revision,
						authorityEpoch: t.authorityEpoch,
						executionGeneration: t.executionGeneration,
					});
			}
		}
		return cleanupInTransaction(tx);
	}
	return {
		createInTransaction,
		requestStartInTransaction,
		requestStopInTransaction,
		forgetInTransaction,
		settleStopInTransaction,
		amendGrantInTransaction,
		applyTransitionInTransaction,
		askInTransaction,
		answerInTransaction,
		getInTransaction: (tx: Database, taskId: string) => repo.get(tx, taskId),
		questionInTransaction: (tx: Database, questionId: string) =>
			repo.question(tx, questionId),
		assertFenceInTransaction: fence,
		create: (input: CreateTask, context?: TrustedTaskContext) =>
			writeCommand(
				(tx) => createInTransaction(tx, input, context),
				"tasks.registered",
			),
		start: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => requestStartInTransaction(tx, taskId, input),
				"tasks.start_requested",
			),
		stop: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => requestStopInTransaction(tx, taskId, input),
				"tasks.stop_requested",
			),
		amend: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => amendGrantInTransaction(tx, taskId, input),
				"tasks.grant_amended",
			),
		answer: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => answerInTransaction(tx, taskId, input),
				"tasks.answered",
			),
		forget: (taskId: string, input: unknown) =>
			store.write((tx) => forgetInTransaction(tx, taskId, input)),
		get(taskId: string) {
			return store.readSnapshot((tx) => {
				const t = requireTask(tx, taskId);
				const actions: (
					| "start"
					| "amend"
					| "answer"
					| "pause"
					| "cancel"
					| "forget"
				)[] = [];
				const valid =
					Date.parse(t.grant.expiresAt) > now() &&
					(t.executionDeadlineAt === null ||
						Date.parse(t.executionDeadlineAt) > now());
				if (t.forgottenAt === null) actions.push("forget");
				if (
					["registered", "paused"].includes(t.state) &&
					valid &&
					kindFor(t)?.available()
				)
					actions.push("start");
				if (
					!terminal(t.state) &&
					!["stopping", "reconciling"].includes(t.state) &&
					(t.executionDeadlineAt === null ||
						Date.parse(t.executionDeadlineAt) > now())
				)
					actions.push("amend");
				if (
					t.state === "waiting_user" &&
					valid &&
					kindFor(t)?.available() &&
					kindFor(t)?.answerInTransaction
				)
					actions.push("answer");
				if (!terminal(t.state)) {
					if (!["stopping", "paused"].includes(t.state)) actions.push("pause");
					if (t.stopIntent !== "cancel") actions.push("cancel");
				}
				return {
					task: t,
					question: repo.openQuestion(tx, taskId),
					availableActions: actions,
					execution: null,
					supervisor: null,
					latestReport: null,
				};
			});
		},
		list(
			query: {
				state?: WorkTask["state"];
				conversationId?: string;
				cursor?: string;
				limit?: number;
			} = {},
		) {
			const size = query.limit ?? 50;
			const cursor =
				query.cursor === undefined ? undefined : Number(query.cursor);
			if (
				!Number.isInteger(size) ||
				size < 1 ||
				size > 100 ||
				(cursor !== undefined &&
					(!/^[1-9]\d*$/.test(query.cursor!) ||
						!Number.isSafeInteger(cursor) ||
						cursor < 1))
			)
				throw new Error("invalid_cursor");
			const rows = store.read((tx) =>
				repo.list(tx, { ...query, cursor, limit: size + 1 }),
			);
			return {
				items: rows.slice(0, size).map((r) => r.task),
				nextCursor: rows.length > size ? String(rows[size - 1]!.seq) : null,
			};
		},
		events(taskId: string, cursor = "0", limit = 50) {
			const after = Number(cursor);
			if (
				!/^\d+$/.test(cursor) ||
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				throw new Error("invalid_cursor");
			return store.readSnapshot((tx) => {
				const t = requireTask(tx, taskId);
				if (after > t.eventSeq) throw new Error("invalid_cursor");
				const items = repo.events(tx, taskId, after, limit);
				return {
					items,
					nextCursor: String(items.at(-1)?.seq ?? after),
					historyExpired: t.metadataExpired,
				};
			});
		},
		liveInTransaction: repo.live,
		runtimeInTransaction: repo.runtime,
		setRuntimeInTransaction(
			tx: Database,
			taskId: string,
			refs: repo.TaskRuntimeRefs,
		) {
			requireTask(tx, taskId);
			repo.setRuntime(tx, taskId, refs);
		},
		maintenance: () => store.write(maintenanceInTransaction),
		async recover() {
			return store.write((tx) => {
				maintenanceInTransaction(tx);
				// Without a runner receipt, previously started work is unknown, never replayed.
				for (const t of repo.live(tx))
					if (["queued", "active", "waiting_user"].includes(t.state)) {
						t.state = "reconciling";
						const q = repo.openQuestion(tx, t.id);
						if (q) repo.putQuestion(tx, { ...q, state: "superseded" });
						record(tx, t, "recovery_requires_receipt");
					}
				return { live: repo.live(tx).length };
			});
		},
	};
}
export type TasksService = ReturnType<typeof createTasks>;
export type { TaskGrant, TaskOrigin };
