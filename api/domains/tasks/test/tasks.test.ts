import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	createTasks,
	migration,
	type TaskFence,
	type TaskKindDefinition,
} from "..";
import { createTaskSchema, workTaskSchema } from "../contracts";
import { capacity } from "../repository";

const stores: SqliteStore[] = [],
	dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const T0 = Date.parse("2026-10-09T00:00:00Z");
function setup(
	ready = true,
	extra: Partial<Parameters<typeof createTasks>[1]> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-tasks-"));
	dirs.push(dir);
	const file = join(dir, "db");
	const store = openStore(file, [migration]);
	stores.push(store);
	const clock = { t: T0 },
		hooks = { starts: 0, stops: 0, answers: 0, fail: false };
	const kind: TaskKindDefinition = {
		kind: "coding",
		version: 1,
		available: () => ready,
		startInTransaction() {
			hooks.starts++;
			if (hooks.fail) throw new Error("fixture_failed");
		},
		stopInTransaction() {
			hooks.stops++;
		},
		answerInTransaction() {
			hooks.answers++;
		},
	};
	const tasks = createTasks(store, {
		now: () => clock.t,
		kinds: [kind],
		...extra,
	});
	return { store, file, tasks, clock, hooks };
}
const input = (startMode: "start" | "register_only" = "start") =>
	createTaskSchema.parse({
		requestId: crypto.randomUUID(),
		kind: "coding",
		version: 1,
		title: "fixture task",
		request: "implement the requested change",
		completionConditions: ["checks pass"],
		startMode,
		grant: {
			workspaceId: "fixture-workspace",
			operations: ["read", "edit", "check", "review"],
			expiresAt: new Date(T0 + 3_600_000).toISOString(),
		},
	});
const cmd = (expectedRevision: number) => ({
	requestId: crypto.randomUUID(),
	expectedRevision,
});
function fence(h: ReturnType<typeof setup>, taskId: string): TaskFence {
	const t = h.tasks.get(taskId).task;
	return {
		taskId,
		expectedRevision: t.revision,
		authorityEpoch: t.authorityEpoch,
		executionGeneration: t.executionGeneration,
	};
}
const activate = (h: ReturnType<typeof setup>, taskId: string) =>
	h.store.write((tx) =>
		h.tasks.applyTransitionInTransaction(tx, fence(h, taskId), {
			state: "active",
			phase: "implementing",
			reason: "fixture_started",
		}),
	);

test("100 identical registrations return one receipt, with conflict on changed input and no automatic text dedupe", async () => {
	const h = setup();
	const data = input("register_only");
	const first = await h.tasks.create(data);
	for (let n = 0; n < 99; n++)
		expect(await h.tasks.create(data)).toEqual(first);
	expect(h.tasks.list().items).toHaveLength(1);
	expect(h.hooks.starts).toBe(0);
	await expect(h.tasks.create({ ...data, title: "different" })).rejects.toThrow(
		"request_conflict",
	);
	await h.tasks.create({ ...data, requestId: crypto.randomUUID() });
	expect(h.tasks.list().items).toHaveLength(2);
});
test("start is idempotent after revisions change; unavailable execution rolls back the whole initial registration", async () => {
	const h = setup();
	const created = await h.tasks.create(input("register_only"));
	const start = cmd(created.revision);
	const accepted = await h.tasks.start(created.taskId, start);
	await activate(h, created.taskId);
	expect(await h.tasks.start(created.taskId, start)).toEqual(accepted);
	expect(h.hooks.starts).toBe(1);
	await expect(
		h.tasks.start(created.taskId, cmd(created.revision)),
	).rejects.toThrow("revision_conflict");
	const offline = setup(false);
	await expect(offline.tasks.create(input())).rejects.toThrow(
		"task_execution_unavailable",
	);
	expect(offline.tasks.list().items).toHaveLength(0);
	const saved = await offline.tasks.create(input("register_only"));
	await expect(
		offline.tasks.start(saved.taskId, cmd(saved.revision)),
	).rejects.toThrow("task_execution_unavailable");
	expect(offline.tasks.get(saved.taskId).task.state).toBe("registered");
});
test("a failed transaction hook rolls back task, grant, commands and events", async () => {
	const h = setup();
	h.hooks.fail = true;
	const data = input();
	await expect(h.tasks.create(data)).rejects.toThrow("fixture_failed");
	for (const table of [
		"work_tasks",
		"work_task_grants",
		"work_task_commands",
		"work_task_events",
	])
		expect(
			h.store.read((tx) =>
				tx.query(`SELECT count(*) AS n FROM ${table}`).get(),
			),
		).toEqual({ n: 0 });
	h.hooks.fail = false;
	expect((await h.tasks.create(data)).state).toBe("queued");
});
test("authority change fences old work, requests a confirmed pause, then resume creates a new execution generation", async () => {
	const h = setup();
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	const old = fence(h, r.taskId);
	const t = h.tasks.get(r.taskId).task;
	const amend = {
		...cmd(t.revision),
		grant: { ...t.grant, operations: ["read"] },
	};
	const updated = await h.tasks.amend(t.id, amend);
	expect(updated.authorityEpoch).toBe(old.authorityEpoch + 1);
	expect(updated.state).toBe("stopping");
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, old, {
				state: "completed",
				reason: "stale_done",
			}),
		),
	).rejects.toThrow("revision_conflict");
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, t.id)),
	);
	expect(h.tasks.get(t.id).task.state).toBe("paused");
	const resumed = await h.tasks.start(
		t.id,
		cmd(h.tasks.get(t.id).task.revision),
	);
	expect(resumed.executionGeneration).toBe(old.executionGeneration + 1);
	expect(await h.tasks.amend(t.id, amend)).toEqual(updated);
});
test("stop receipt is stopping until confirmed, cancel cannot be downgraded to pause, late completion cannot win", async () => {
	const h = setup();
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	const old = fence(h, r.taskId),
		stop = { ...cmd(old.expectedRevision), intent: "cancel" };
	const receipt = await h.tasks.stop(r.taskId, stop);
	expect(receipt.state).toBe("stopping");
	expect(h.tasks.get(r.taskId).task.state).toBe("stopping");
	await expect(
		h.tasks.stop(r.taskId, { ...cmd(receipt.revision), intent: "pause" }),
	).rejects.toThrow("task_state_conflict");
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, old, {
				state: "active",
				reason: "late",
			}),
		),
	).rejects.toThrow("revision_conflict");
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, r.taskId)),
	);
	expect(h.tasks.get(r.taskId).task.state).toBe("cancelled");
	expect(await h.tasks.stop(r.taskId, stop)).toEqual(receipt);
	await expect(
		h.tasks.start(r.taskId, cmd(h.tasks.get(r.taskId).task.revision)),
	).rejects.toThrow("task_state_conflict");
});
test("an unstarted registration can be cancelled without requiring a runner", async () => {
	const h = setup(false);
	const r = await h.tasks.create(input("register_only"));
	expect(
		(await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "cancel" }))
			.state,
	).toBe("stopping");
	expect(h.tasks.get(r.taskId).task.state).toBe("cancelled");
});
test("answers bind task, question, revision, epoch and generation, and only valid choices resume the task", async () => {
	const h = setup();
	const a = await h.tasks.create(input()),
		b = await h.tasks.create(input());
	await activate(h, a.taskId);
	await h.store.write((tx) =>
		h.tasks.askInTransaction(tx, fence(h, a.taskId), {
			questionId: "fixture-question",
			prompt: "Choose a target",
			answerType: "choice",
			choices: [" first ", "second"],
		}),
	);
	const t = h.tasks.get(a.taskId).task;
	await expect(
		h.tasks.answer(b.taskId, {
			...cmd(h.tasks.get(b.taskId).task.revision),
			questionId: "fixture-question",
			answer: "first",
		}),
	).rejects.toThrow("task_question_conflict");
	await expect(
		h.tasks.answer(a.taskId, {
			...cmd(t.revision),
			questionId: "fixture-question",
			answer: "unexpected",
		}),
	).rejects.toThrow("invalid_task_answer");
	const answer = {
		...cmd(t.revision),
		questionId: "fixture-question",
		answer: "first",
	};
	const receipt = await h.tasks.answer(a.taskId, answer);
	expect(receipt.state).toBe("queued");
	expect(h.tasks.get(a.taskId).question).toBeNull();
	expect(h.hooks.answers).toBe(1);
	expect(await h.tasks.answer(a.taskId, answer)).toEqual(receipt);
	await expect(
		h.tasks.answer(a.taskId, {
			...answer,
			requestId: crypto.randomUUID(),
			expectedRevision: receipt.revision,
		}),
	).rejects.toThrow("task_question_conflict");
});
test("concurrent answer and cancellation have a single winner and supersede obsolete questions", async () => {
	const h = setup();
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	await h.store.write((tx) =>
		h.tasks.askInTransaction(tx, fence(h, r.taskId), {
			questionId: "q",
			prompt: "What next?",
			answerType: "text",
			choices: [],
		}),
	);
	const revision = h.tasks.get(r.taskId).task.revision;
	const results = await Promise.allSettled([
		h.tasks.stop(r.taskId, { ...cmd(revision), intent: "cancel" }),
		h.tasks.answer(r.taskId, {
			...cmd(revision),
			questionId: "q",
			answer: "continue",
		}),
	]);
	expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
	expect(h.tasks.get(r.taskId).question).toBeNull();
	expect(h.hooks.answers).toBe(0);
});
test("task completion requires all declared conditions and evidence, not an arbitrary queue state", async () => {
	const h = setup();
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	const result = {
		summary: "done",
		evidenceRefs: ["receipt:checks"],
		conditionsMet: [false],
	};
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, fence(h, r.taskId), {
				state: "completed",
				reason: "finished",
				result,
			}),
		),
	).rejects.toThrow("invalid_task_result");
	await h.store.write((tx) =>
		h.tasks.applyTransitionInTransaction(tx, fence(h, r.taskId), {
			state: "completed",
			phase: "finalizing",
			reason: "finished",
			result: { ...result, conditionsMet: [true] },
		}),
	);
	expect(h.tasks.get(r.taskId).task.state).toBe("completed");
});
test("reopening preserves tasks independently of conversation lifetime, and recovery does not replay work", async () => {
	const h = setup();
	const context = {
		origin: {
			source: "conversation" as const,
			conversationId: "chat",
			messageId: "user-message",
			runId: "old-run",
			operationKey: "delegate:0",
		},
	};
	const registered = await h.tasks.create(input("register_only"));
	const running = await h.tasks.create(input(), context);
	await h.store.close();
	const store = openStore(h.file, [migration]);
	stores.push(store);
	const recovered = createTasks(store, { now: () => T0 });
	await recovered.recover();
	expect(recovered.get(registered.taskId).task.state).toBe("registered");
	expect(recovered.get(running.taskId).task.state).toBe("reconciling");
	expect(
		recovered.list({ conversationId: "chat" }).items.map((t) => t.id),
	).toEqual([running.taskId]);
	expect(h.hooks.starts).toBe(1);
});
test("conversation input has unique operation provenance even with different request IDs", async () => {
	const h = setup();
	const context = {
		origin: {
			source: "conversation" as const,
			conversationId: "chat",
			messageId: "msg",
			runId: null,
			operationKey: "op",
		},
	};
	await h.tasks.create(input("register_only"), context);
	await expect(h.tasks.create(input("register_only"), context)).rejects.toThrow(
		"task_origin_conflict",
	);
});
test("expired grants fence execution immediately, and maintenance requests cancellation without replay", async () => {
	const h = setup();
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	h.clock.t += 3_600_000;
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, fence(h, r.taskId), {
				state: "active",
				reason: "old_authority",
			}),
		),
	).rejects.toThrow("task_grant_expired");
	await h.tasks.maintenance();
	expect(h.tasks.get(r.taskId).task.state).toBe("stopping");
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, r.taskId)),
	);
	expect(h.tasks.get(r.taskId).task.state).toBe("cancelled");
});
test("terminal bodies expire at seven days, runtime history at thirty, while minimal replay receipts stay valid", async () => {
	const h = setup();
	const data = input("register_only");
	const r = await h.tasks.create(data);
	await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "cancel" });
	h.clock.t += 7 * 86_400_000;
	await h.tasks.maintenance();
	const t = h.tasks.get(r.taskId).task;
	expect(t.request).toBeNull();
	expect(t.bodyExpired).toBe(true);
	expect(t.title).toBe(data.title);
	workTaskSchema.parse(t);
	expect(await h.tasks.create(data)).toEqual(r);
	h.clock.t += 23 * 86_400_000;
	await h.tasks.maintenance();
	expect(h.tasks.get(r.taskId).task.metadataExpired).toBe(true);
	expect(h.tasks.events(r.taskId).historyExpired).toBe(true);
	expect(h.tasks.events(r.taskId).items).toHaveLength(1);
});
test("pagination uses a stable sequence and rejects unsafe cursors and excess byte limits", async () => {
	const h = setup();
	for (let n = 0; n < 3; n++) await h.tasks.create(input("register_only"));
	const first = h.tasks.list({ limit: 2 });
	const second = h.tasks.list({ limit: 2, cursor: first.nextCursor! });
	expect(first.items).toHaveLength(2);
	expect(second.items).toHaveLength(1);
	expect(second.nextCursor).toBeNull();
	expect(new Set([...first.items, ...second.items].map((t) => t.id)).size).toBe(
		3,
	);
	expect(() => h.tasks.list({ cursor: "9007199254740992" })).toThrow(
		"invalid_cursor",
	);
	expect(() => h.tasks.events(first.items[0]!.id, "-1")).toThrow(
		"invalid_cursor",
	);
	await expect(
		h.tasks.create({ ...input(), request: "あ".repeat(12_000) }),
	).rejects.toThrow("invalid_task_input");
	expect(
		createTaskSchema.safeParse({
			...input(),
			origin: { source: "conversation" },
			owner: "forged",
		}).success,
	).toBe(false);
});
test("capacity limits reject new registrations without removing paused or reconciling tasks", async () => {
	const h = setup(true, { maxLiveTasks: 1 });
	await h.tasks.create(input("register_only"));
	await expect(h.tasks.create(input("register_only"))).rejects.toThrow(
		"task_capacity",
	);
	expect(h.tasks.list().items).toHaveLength(1);
});

test("asynchronous domain hooks cannot escape the single writer transaction", async () => {
	const h = setup(true, {
		kinds: [
			{
				kind: "coding",
				version: 1,
				available: () => true,
				startInTransaction: async () => {},
				stopInTransaction: () => {},
			},
		],
	});
	await expect(h.tasks.create(input())).rejects.toThrow(
		"invalid_async_transaction_callback",
	);
	expect(h.tasks.list().items).toHaveLength(0);
});
test("runtime budget is bound to the task and is not extended by pause and resume", async () => {
	const h = setup(),
		data = input();
	data.grant.maxRuntimeMs = 60_000;
	const r = await h.tasks.create(data);
	await activate(h, r.taskId);
	const deadline = h.tasks.get(r.taskId).task.executionDeadlineAt;
	await h.tasks.stop(r.taskId, {
		...cmd(h.tasks.get(r.taskId).task.revision),
		intent: "pause",
	});
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, r.taskId)),
	);
	h.clock.t += 30_000;
	await h.tasks.start(r.taskId, cmd(h.tasks.get(r.taskId).task.revision));
	expect(h.tasks.get(r.taskId).task.executionDeadlineAt).toBe(deadline);
	h.clock.t += 30_000;
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, fence(h, r.taskId), {
				state: "active",
				reason: "old",
			}),
		),
	).rejects.toThrow("task_runtime_expired");
	await h.tasks.maintenance();
	expect(h.tasks.get(r.taskId).task.state).toBe("stopping");
});
test("explicit forgetting revokes live work, redacts private history and cannot be undone by replaying registration", async () => {
	const h = setup(),
		data = input("register_only");
	const context = {
		origin: {
			source: "conversation" as const,
			conversationId: "chat",
			messageId: "msg",
			runId: "run",
			operationKey: "delegate",
		},
	};
	const r = await h.tasks.create(data, context);
	const forgotten = await h.tasks.forget(r.taskId, cmd(r.revision));
	expect(forgotten.state).toBe("stopping");
	const t = h.tasks.get(r.taskId).task;
	expect(t.state).toBe("cancelled");
	expect(t.request).toBeNull();
	expect(t.title).toBe("削除済みタスク");
	expect(t.forgottenAt).not.toBeNull();
	expect(h.tasks.list({ conversationId: "chat" }).items).toHaveLength(0);
	expect(
		h.store.read((tx) =>
			tx
				.query("SELECT count(*) AS n FROM work_task_grants WHERE task_id=?")
				.get(t.id),
		),
	).toEqual({ n: 0 });
	expect(await h.tasks.create(data, context)).toEqual(r);
	expect(h.tasks.get(r.taskId).task.request).toBeNull();
	workTaskSchema.parse(t);
});

test("explicit budget amendments retain the original execution start and apply shorter budgets immediately", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await activate(h, r.taskId);
	h.clock.t += 20_000;
	let t = h.tasks.get(r.taskId).task;
	await h.tasks.amend(t.id, {
		...cmd(t.revision),
		grant: { ...t.grant, maxRuntimeMs: 120_000 },
	});
	expect(h.tasks.get(t.id).task.executionDeadlineAt).toBe(
		new Date(T0 + 120_000).toISOString(),
	);
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, t.id)),
	);
	h.clock.t += 10_000;
	t = h.tasks.get(t.id).task;
	await h.tasks.amend(t.id, {
		...cmd(t.revision),
		grant: { ...t.grant, maxRuntimeMs: 180_000 },
	});
	expect(h.tasks.get(t.id).task.executionDeadlineAt).toBe(
		new Date(T0 + 180_000).toISOString(),
	);
	await h.tasks.start(t.id, cmd(h.tasks.get(t.id).task.revision));
	expect(h.tasks.get(t.id).task.executionDeadlineAt).toBe(
		new Date(T0 + 180_000).toISOString(),
	);
});

test("expiry of a confirmed pause reaches cancelled without another runner acknowledgement", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "pause" });
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, r.taskId)),
	);
	h.clock.t += 3_600_000;
	await h.tasks.maintenance();
	expect(h.tasks.get(r.taskId).task.state).toBe("cancelled");
});

test("invalid runtime question types cannot create an unreadable waiting state", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await activate(h, r.taskId);
	await expect(
		h.store.write((tx) =>
			h.tasks.askInTransaction(tx, fence(h, r.taskId), {
				questionId: "bad-question",
				prompt: "Choose",
				answerType: "unexpected",
				choices: [],
			} as unknown as Parameters<typeof h.tasks.askInTransaction>[2]),
		),
	).rejects.toThrow("invalid_task_question");
	expect(h.tasks.get(r.taskId).task.state).toBe("active");
	expect(h.tasks.get(r.taskId).question).toBeNull();
});

test("storage admission bounds new grant history while revocation and cancellation remain available", async () => {
	const baseline = setup(),
		data = input("register_only");
	await baseline.tasks.create(data);
	const bytes = baseline.store.read(capacity).bytes;
	const h = setup(true, { maxStorageBytes: bytes + 50 });
	const r = await h.tasks.create(data),
		t = h.tasks.get(r.taskId).task;
	await expect(
		h.tasks.amend(t.id, {
			...cmd(t.revision),
			grant: { ...t.grant, operations: [...t.grant.operations, "commit"] },
		}),
	).rejects.toThrow("task_capacity");
	expect(h.tasks.get(t.id).task).toEqual(t);
	await h.tasks.amend(t.id, {
		...cmd(t.revision),
		grant: { ...t.grant, operations: ["read"] },
	});
	expect(h.tasks.get(t.id).task.grant.operations).toEqual(["read"]);
	await h.tasks.stop(t.id, {
		...cmd(h.tasks.get(t.id).task.revision),
		intent: "cancel",
	});
	expect(h.tasks.get(t.id).task.state).toBe("cancelled");
});

test("public list operations reject nondecimal cursors just like the HTTP contract", async () => {
	const h = setup();
	await h.tasks.create(input("register_only"));
	for (const cursor of ["1e0", " 1", "+1", "01"])
		expect(() => h.tasks.list({ cursor })).toThrow("invalid_cursor");
});

test("shortening a running budget below elapsed time immediately requests cancellation", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await activate(h, r.taskId);
	const previous = fence(h, r.taskId);
	h.clock.t += 90_000;
	const t = h.tasks.get(r.taskId).task;
	await h.tasks.amend(t.id, {
		...cmd(t.revision),
		grant: { ...t.grant, maxRuntimeMs: 60_000 },
	});
	expect(h.tasks.get(t.id).task.stopIntent).toBe("cancel");
	expect(h.tasks.get(t.id).task.state).toBe("stopping");
	await expect(
		h.store.write((tx) =>
			h.tasks.applyTransitionInTransaction(tx, previous, {
				state: "active",
				reason: "late",
			}),
		),
	).rejects.toThrow("revision_conflict");
	await h.store.write((tx) =>
		h.tasks.settleStopInTransaction(tx, fence(h, t.id)),
	);
	expect(h.tasks.get(t.id).task.state).toBe("cancelled");
});

test("oversized question material rolls back both the question and waiting state", async () => {
	const baseline = setup(),
		data = input(),
		first = await baseline.tasks.create(data);
	await activate(baseline, first.taskId);
	const h = setup(true, {
			maxStorageBytes: baseline.store.read(capacity).bytes + 50,
		}),
		r = await h.tasks.create(data);
	await activate(h, r.taskId);
	const before = h.tasks.get(r.taskId).task;
	await expect(
		h.store.write((tx) =>
			h.tasks.askInTransaction(tx, fence(h, r.taskId), {
				questionId: "budget-question",
				prompt: "x".repeat(8000),
				answerType: "text",
				choices: [],
			}),
		),
	).rejects.toThrow("task_capacity");
	expect(h.tasks.get(r.taskId).task).toEqual(before);
	expect(h.tasks.get(r.taskId).question).toBeNull();
});

test("Promise-like transaction callbacks are rejected as well as native Promises", async () => {
	const h = setup(true, {
		kinds: [
			{
				kind: "coding",
				version: 1,
				available: () => true,
				startInTransaction: () => ({
					// oxlint-disable-next-line unicorn/no-thenable -- Intentionally invalid transaction callback fixture.
					then: (resolve: () => void) => resolve(),
				}),
				stopInTransaction: () => {},
			},
		],
	});
	await expect(h.tasks.create(input())).rejects.toThrow(
		"invalid_async_transaction_callback",
	);
	expect(h.tasks.list().items).toHaveLength(0);
});

test("available actions reflect a missing answer capability and an exhausted runtime", async () => {
	const h = setup(true, {
		kinds: [
			{
				kind: "coding",
				version: 1,
				available: () => true,
				startInTransaction: () => {},
				stopInTransaction: () => {},
			},
		],
	});
	const r = await h.tasks.create(input());
	await activate(h, r.taskId);
	await h.store.write((tx) =>
		h.tasks.askInTransaction(tx, fence(h, r.taskId), {
			questionId: "unsupported-answer",
			prompt: "Continue?",
			answerType: "text",
			choices: [],
		}),
	);
	expect(h.tasks.get(r.taskId).availableActions).not.toContain("answer");
	h.clock.t += 7_200_000;
	expect(h.tasks.get(r.taskId).availableActions).not.toContain("amend");
});

test("expiry while pause acknowledgement is pending cannot produce a resumable pause", async () => {
	for (const runMaintenance of [false, true]) {
		const h = setup(),
			r = await h.tasks.create(input());
		await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "pause" });
		h.clock.t += 3_600_000;
		if (runMaintenance) {
			await h.tasks.maintenance();
			expect(h.tasks.get(r.taskId).task.stopIntent).toBe("cancel");
		}
		await h.store.write((tx) =>
			h.tasks.settleStopInTransaction(tx, fence(h, r.taskId)),
		);
		expect(h.tasks.get(r.taskId).task.state).toBe("cancelled");
		expect(h.tasks.get(r.taskId).task.stopIntent).toBe("cancel");
	}
});
