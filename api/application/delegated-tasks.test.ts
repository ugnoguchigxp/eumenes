import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore } from "../infrastructure/sqlite";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createConversationService } from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import type { LarmPort } from "../domains/larm";
import { createTaskSchema } from "../domains/tasks/contracts";
import { createClient, ApiError } from "../../client";
import { loadConfig } from "../infrastructure/config";
import { createApp } from "./app";
import { appModules } from "./app-modules";
import { migrations } from "./migrations";
import {
	createDelegatedTasks,
	type TaskExecutionPort,
} from "./delegated-tasks";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const T0 = Date.parse("2026-10-09T00:00:00Z"),
	token = "fixture-token".repeat(3);
function setup(
	options: {
		offline?: boolean;
		executionReady?: boolean;
		disabled?: boolean;
		stopConfirmed?: boolean;
		stopResult?: unknown;
		dispatchGate?: Promise<void>;
		backlogBatches?: number;
		queueLimit?: number;
		scheduleLimit?: number;
		prepareResult?: () => unknown;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-delegated-")),
		path = join(dir, "db");
	const store = openStore(path, migrations),
		clock = { t: T0 };
	const queue = createQueue(store, {
		now: () => clock.t,
		...(options.queueLimit
			? {
					limits: {
						total: options.queueLimit,
						background: options.queueLimit,
						scope: options.queueLimit,
					},
				}
			: {}),
	});
	const scheduler = createScheduler(store, queue, {
		now: () => clock.t,
		maxSchedules: options.scheduleLimit,
	});
	const calls = {
		dispatch: 0,
		dispatchSignals: [] as AbortSignal[],
		observe: 0,
		stop: 0,
		stopIds: [] as string[],
		answers: [] as string[],
		blockedObservation: false,
	};
	let release = () => {};
	const execution: TaskExecutionPort = {
		available: () => options.executionReady !== false,
		prepareInTransaction: () => options.prepareResult?.(),
		async dispatch(_task, context) {
			calls.dispatch++;
			calls.dispatchSignals.push(context.signal);
			await options.dispatchGate;
			if (context.answer) calls.answers.push(context.answer.text);
			return { accepted: true };
		},
		async observe() {
			calls.observe++;
			if (calls.blockedObservation)
				await new Promise<void>((r) => {
					release = r;
				});
			return { hasMore: calls.observe <= (options.backlogBatches ?? 0) };
		},
		async stop(_task, context) {
			calls.stop++;
			calls.stopIds.push(context.commandId);
			return {
				stopped:
					options.stopResult !== undefined
						? (options.stopResult as boolean)
						: options.stopConfirmed !== false,
			};
		},
	};
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: !options.disabled,
		now: () => clock.t,
		execution: options.offline ? undefined : execution,
	});
	const conversation = createConversationService(store);
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		answer: async () => "fixture answer",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
	};
	const dialogue = createDialogueService({ store, queue, conversation, larm }),
		voice = createVoiceDialogue(store, dialogue, larm);
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: appModules({
			queue,
			scheduler,
			conversation,
			dialogue,
			voice,
			larm,
			tasks: delegated.tasks,
		}),
	});
	cleanup.push(async () => {
		release();
		delegated.close();
		await scheduler.close();
		await queue.close(1000);
		await voice.close();
		await dialogue.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const call = (
		path: string,
		body?: unknown,
		headers = {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
	) =>
		app.request(path, {
			headers,
			...(body === undefined
				? {}
				: { method: "POST", body: JSON.stringify(body) }),
		});
	return {
		store,
		clock,
		queue,
		scheduler,
		delegated,
		tasks: delegated.tasks,
		calls,
		call,
		app,
		dir,
		path,
		release: () => release(),
	};
}
function input(startMode: "start" | "register_only" = "start") {
	return createTaskSchema.parse({
		requestId: crypto.randomUUID(),
		kind: "coding",
		version: 1,
		title: "fixture task",
		request: "implement a change",
		completionConditions: ["checks pass"],
		startMode,
		grant: {
			workspaceId: "fixture",
			operations: ["read", "edit", "check"],
			expiresAt: new Date(T0 + 3_600_000).toISOString(),
		},
	});
}
const cmd = (expectedRevision: number) => ({
	requestId: crypto.randomUUID(),
	expectedRevision,
});
async function until(predicate: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("fixture_timeout");
}
const jobs = (h: ReturnType<typeof setup>, kind: string) =>
	h.queue.list({ kind }).items;

test("atomic start links one task, dispatch and schedule; 100 retries create nothing extra", async () => {
	const h = setup(),
		data = input();
	const first = await h.tasks.create(data);
	for (let n = 0; n < 99; n++)
		expect(await h.tasks.create(data)).toEqual(first);
	expect(h.tasks.list().items).toHaveLength(1);
	expect(jobs(h, "tasks.dispatch.v1")).toHaveLength(1);
	expect(h.scheduler.list().items).toHaveLength(1);
	await h.queue.tick();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "completed");
	expect(h.calls.dispatch).toBe(1);
	expect(h.tasks.get(first.taskId).task.state).toBe("active");
	// Receipt means accepted work; a completed dispatch job does not mean a completed task.
});
test("registration-only has no jobs or schedules, reads emit no commit, unsupported start is explicit", async () => {
	const h = setup({ offline: true });
	let commits = 0;
	const unsubscribe = h.store.onCommit(() => commits++);
	const data = input("register_only"),
		r = await h.tasks.create(data);
	expect(commits).toBe(1);
	expect(await h.tasks.create(data)).toEqual(r);
	h.tasks.get(r.taskId);
	h.tasks.list();
	h.tasks.events(r.taskId);
	expect(commits).toBe(1);
	expect(h.queue.list().items).toHaveLength(0);
	expect(h.scheduler.list().items).toHaveLength(0);
	expect(
		(await h.call(`/api/tasks/${r.taskId}/start`, cmd(r.revision))).status,
	).toBe(503);
	expect(h.tasks.get(r.taskId).task.state).toBe("registered");
	unsubscribe();
});
test("Queue or Scheduler capacity failure rolls back every part of registration", async () => {
	const h = setup({ queueLimit: 1 });
	await h.tasks.create(input());
	await expect(h.tasks.create(input())).rejects.toThrow("queue_full");
	expect(h.tasks.list().items).toHaveLength(1);
	expect(h.scheduler.list().items).toHaveLength(1);
	const blocked = setup({ scheduleLimit: 0 });
	await expect(blocked.tasks.create(input())).rejects.toThrow(
		"schedule_limit_reached",
	);
	expect(blocked.tasks.list().items).toHaveLength(0);
	expect(blocked.queue.list().items).toHaveLength(0);
	expect(blocked.scheduler.list().items).toHaveLength(0);
});
test("60-second observation coalesces missed ticks, skips overlap and never changes business revision", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await h.queue.tick();
	await until(
		() =>
			h.calls.dispatch === 1 &&
			jobs(h, "tasks.dispatch.v1")[0]?.state === "completed",
	);
	const revision = h.tasks.get(r.taskId).task.revision;
	h.clock.t += 59_999;
	await h.scheduler.tick();
	expect(h.calls.observe).toBe(0);
	h.clock.t++;
	h.calls.blockedObservation = true;
	await h.scheduler.tick();
	await h.queue.tick();
	await until(() => h.calls.observe === 1);
	h.clock.t += 60_000;
	await h.scheduler.tick();
	expect(jobs(h, "tasks.observe.v1")).toHaveLength(1);
	expect(
		h.scheduler.listOccurrences(h.scheduler.list().items[0]!.id).items[0]
			?.reason,
	).toBe("overlap");
	h.calls.blockedObservation = false;
	h.release();
	await until(() => jobs(h, "tasks.observe.v1")[0]?.state === "completed");
	h.clock.t += 30 * 60_000;
	await h.scheduler.tick();
	expect(jobs(h, "tasks.observe.v1")).toHaveLength(2);
	expect(h.tasks.get(r.taskId).task.revision).toBe(revision);
});
test("cancellation invalidates queued dispatch and disables monitoring, but only confirmed stop is terminal", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	const stopped = await h.tasks.stop(r.taskId, {
		...cmd(r.revision),
		intent: "cancel",
	});
	expect(stopped.state).toBe("stopping");
	expect(jobs(h, "tasks.dispatch.v1")[0]?.state).toBe("cancelled");
	expect(h.scheduler.list().items[0]?.state).toBe("cancelled");
	await h.queue.tick();
	await until(() => h.tasks.get(r.taskId).task.state === "cancelled");
	expect(h.calls.dispatch).toBe(0);
	expect(h.calls.stop).toBe(1);
	h.clock.t += 60_000;
	await h.scheduler.tick();
	expect(h.calls.observe).toBe(0);
});
test("an unconfirmed stop cannot complete its job or the task", async () => {
	const h = setup({ stopConfirmed: false }),
		r = await h.tasks.create(input());
	await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "cancel" });
	await h.queue.tick();
	await until(() => jobs(h, "tasks.stop.v1")[0]?.state === "failed");
	expect(h.tasks.get(r.taskId).task.state).toBe("stopping");
});

test("failed stop delivery is retried after recovery with one stable stop command and no new dispatch", async () => {
	const options = { stopConfirmed: false },
		h = setup(options),
		r = await h.tasks.create(input());
	await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "cancel" });
	await h.queue.tick();
	await until(() => jobs(h, "tasks.stop.v1")[0]?.state === "failed");
	await h.queue.recover();
	await h.delegated.recover();
	expect(jobs(h, "tasks.stop.v1")).toHaveLength(1);
	h.clock.t += 60_000;
	options.stopConfirmed = true;
	await h.tasks.maintenance();
	await h.tasks.maintenance();
	expect(jobs(h, "tasks.stop.v1")).toHaveLength(2);
	await h.queue.tick();
	await until(() => h.tasks.get(r.taskId).task.state === "cancelled");
	expect(h.calls.stop).toBe(2);
	expect(new Set(h.calls.stopIds).size).toBe(1);
	expect(h.calls.dispatch).toBe(0);
});

test("a generic schedule cannot duplicate or replace the task-owned monitor", async () => {
	const h = setup(),
		r = await h.tasks.create(input()),
		t = h.tasks.get(r.taskId).task;
	const scheduleInput = {
		requestId: crypto.randomUUID(),
		target: {
			kind: "tasks.observe.v1",
			payload: {
				taskId: t.id,
				authorityEpoch: t.authorityEpoch,
				executionGeneration: t.executionGeneration,
			},
		},
		schedule: {
			type: "interval" as const,
			anchor: new Date(T0).toISOString(),
			intervalMs: 60_000,
		},
	};
	const response = await h.call("/api/schedules", scheduleInput);
	expect(response.status).toBe(400);
	expect(h.scheduler.list().items).toHaveLength(1);
	const owned = h.scheduler.list().items[0]!;
	await h.scheduler.cancel(owned.id, owned.revision);
	expect(
		(
			await h.call("/api/schedules", {
				...scheduleInput,
				requestId: crypto.randomUUID(),
			})
		).status,
	).toBe(400);
	expect(h.scheduler.list().items).toHaveLength(1);
});

test("a lost execution connection before dispatch moves the task to reconciliation without sending work", async () => {
	const options = { executionReady: true },
		h = setup(options),
		r = await h.tasks.create(input());
	options.executionReady = false;
	await h.queue.tick();
	expect(h.tasks.get(r.taskId).task.state).toBe("reconciling");
	expect(h.scheduler.list().items[0]?.state).toBe("cancelled");
	expect(h.calls.dispatch).toBe(0);
	options.executionReady = true;
	await h.queue.tick();
	expect(h.calls.dispatch).toBe(0);
});

test("a failed dispatch preparation cannot leave a queued task with no runnable job", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	const transition = h.tasks.applyTransitionInTransaction;
	h.tasks.applyTransitionInTransaction = (tx, fence, state) => {
		if (state.state === "active") throw new Error("fixture_prepare_failed");
		return transition(tx, fence, state);
	};
	await h.queue.tick();
	expect(h.tasks.get(r.taskId).task.state).toBe("reconciling");
	expect(h.scheduler.list().items[0]?.state).toBe("cancelled");
	expect(h.calls.dispatch).toBe(0);
});

test("cancelling dispatch through the generic Queue API leaves explicit reconciliation rather than an orphaned task", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	const job = jobs(h, "tasks.dispatch.v1")[0]!;
	await h.queue.cancel(job.id);
	expect(h.tasks.get(r.taskId).task.state).toBe("reconciling");
	expect(h.scheduler.list().items[0]?.state).toBe("cancelled");
	await h.queue.tick();
	expect(h.calls.dispatch).toBe(0);
	expect(jobs(h, "tasks.dispatch.v1")[0]?.state).toBe("cancelled");
});

test("a truthy malformed stop receipt is never adopted as confirmed", async () => {
	const h = setup({ stopResult: "yes" }),
		r = await h.tasks.create(input());
	await h.tasks.stop(r.taskId, { ...cmd(r.revision), intent: "cancel" });
	await h.queue.tick();
	await until(() => jobs(h, "tasks.stop.v1")[0]?.state === "failed");
	expect(h.tasks.get(r.taskId).task.state).toBe("stopping");
});

test("a rolled-back revocation never aborts a live dispatch on the next unrelated commit", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = setup({ dispatchGate: gate }),
		r = await h.tasks.create(input());
	await h.queue.tick();
	await until(() => h.calls.dispatch === 1);
	const t = h.tasks.get(r.taskId).task;
	await expect(
		h.store.write((tx) => {
			h.tasks.amendGrantInTransaction(tx, t.id, {
				...cmd(t.revision),
				grant: { ...t.grant, operations: ["read"] },
			});
			throw new Error("fixture_rollback");
		}),
	).rejects.toThrow("fixture_rollback");
	await h.tasks.create(input("register_only"));
	expect(h.calls.dispatchSignals[0]?.aborted).toBe(false);
	expect(h.tasks.get(t.id).task).toEqual(t);
	expect(jobs(h, "tasks.stop.v1")).toHaveLength(0);
	release();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "completed");
});

test("task HTTP bodies are rejected while streaming past the bound, before the peer finishes sending", async () => {
	const h = setup({ offline: true });
	let chunks = 0,
		cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				chunks++;
				if (chunks <= 5) controller.enqueue(new Uint8Array(17_000).fill(32));
				else controller.close();
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const response = await h.app.request(
		new Request("http://localhost/api/tasks", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body,
		}),
	);
	expect(response.status).toBe(413);
	expect(chunks).toBe(4);
	expect(cancelled).toBe(true);
	expect(h.tasks.list().items).toHaveLength(0);
});
test("saved answers are passed to the next dispatch without leaking another task's answer", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await h.queue.tick();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "completed");
	const t = h.tasks.get(r.taskId).task;
	await h.store.write((tx) =>
		h.tasks.askInTransaction(
			tx,
			{
				taskId: t.id,
				expectedRevision: t.revision,
				authorityEpoch: t.authorityEpoch,
				executionGeneration: t.executionGeneration,
			},
			{
				questionId: "fixture-question",
				prompt: "Which approach?",
				answerType: "text",
				choices: [],
			},
		),
	);
	await h.tasks.answer(t.id, {
		...cmd(h.tasks.get(t.id).task.revision),
		questionId: "fixture-question",
		answer: "use the registered approach",
	});
	await h.queue.tick();
	await until(() => h.calls.dispatch === 2);
	expect(h.calls.answers).toEqual(["use the registered approach"]);
});
test("recovery after registration commit cancels old dispatch without starting it again", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await h.queue.recover();
	await h.delegated.recover();
	await h.scheduler.recover();
	expect(h.tasks.get(r.taskId).task.state).toBe("reconciling");
	await h.queue.tick();
	expect(h.calls.dispatch).toBe(0);
	expect(h.scheduler.list().items[0]?.state).toBe("cancelled");
});
test("HTTP rejects spoofed origins and arbitrary state, authenticates tasks, and validates query limits", async () => {
	const h = setup({ offline: true }),
		data = input("register_only");
	expect(
		(
			await h.call("/api/tasks", data, {
				authorization: "",
				"content-type": "application/json",
			})
		).status,
	).toBe(401);
	expect(
		(
			await h.call("/api/tasks", {
				...data,
				origin: { source: "conversation", messageId: "forged" },
			})
		).status,
	).toBe(400);
	expect(
		(await h.call("/api/tasks", { ...data, state: "completed" })).status,
	).toBe(400);
	const response = await h.call("/api/tasks", data);
	expect(response.status).toBe(202);
	const r = (await response.json()) as { taskId: string };
	expect(response.headers.get("X-Request-Id")).toBeString();
	expect((await h.call(`/api/tasks/${r.taskId}`)).status).toBe(200);
	expect((await h.call("/api/tasks?limit=101")).status).toBe(400);
	expect((await h.call("/api/tasks?state=anything")).status).toBe(400);
	expect((await h.call("/api/tasks/missing")).status).toBe(404);
	const invalidObservation = await h.call("/api/schedules", {
		requestId: crypto.randomUUID(),
		target: {
			kind: "tasks.observe.v1",
			payload: {
				taskId: r.taskId,
				authorityEpoch: 1,
				executionGeneration: 0,
			},
		},
		schedule: {
			type: "interval",
			anchor: new Date(T0).toISOString(),
			intervalMs: 60_000,
		},
	});
	expect(invalidObservation.status).toBe(400);
	expect(await invalidObservation.json()).toEqual({
		error: "invalid_task_observation",
	});
	expect(h.scheduler.list().items).toHaveLength(0);
	expect(
		(await h.call(`/api/tasks/${r.taskId}/events?cursor=999`)).status,
	).toBe(400);
});
test("API client and CLI register, read and cancel through authenticated HTTP; unavailable execution stays explicit", async () => {
	const h = setup({ offline: true }),
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
	cleanup.push(async () => {
		await server.stop(true);
	});
	const url = `http://127.0.0.1:${server.port}`,
		client = createClient(url, token);
	const data = input("register_only");
	const created = await client.createTask({
		...data,
		grant: {
			workspaceId: data.grant.workspaceId,
			operations: data.grant.operations,
			expiresAt: data.grant.expiresAt,
		},
	});
	const detail = await client.workTask(created.taskId);
	expect(detail.task.state).toBe("registered");
	expect(detail.task.grant.maxRuntimeMs).toBe(7_200_000);
	expect(detail.task.grant.progressIntervalMs).toBe(300_000);
	try {
		await client.startTask(
			created.taskId,
			crypto.randomUUID(),
			created.revision,
		);
		throw new Error("expected error");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(503);
	}
	const dataFile = join(h.dir, "task.json");
	writeFileSync(dataFile, JSON.stringify(input("register_only")), {
		mode: 0o600,
	});
	async function cli(args: string[]) {
		const child = Bun.spawn(
			[process.execPath, "cli/index.ts", "tasks", ...args, "--json"],
			{
				cwd: resolve(import.meta.dir, "../.."),
				env: {
					PATH: process.env.PATH,
					EUMENES_URL: url,
					EUMENES_API_TOKEN: token,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, out, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, out, error };
	}
	const result = await cli(["create", dataFile]);
	expect(result.code).toBe(0);
	const receipt = JSON.parse(result.out);
	for (const args of [
		["list"],
		["show", receipt.taskId],
		["events", receipt.taskId],
	])
		expect((await cli(args)).code).toBe(0);
	const failedStart = await cli([
		"start",
		receipt.taskId,
		String(receipt.revision),
	]);
	expect(failedStart.code).toBe(3);
	expect(failedStart.out).toBe("");
	expect(failedStart.error).toMatch(/Request ID: [0-9a-f-]{36}/);
	const startInput = input("start");
	const { requestId: _requestId, ...generatedInput } = startInput;
	writeFileSync(dataFile, JSON.stringify(generatedInput), { mode: 0o600 });
	const failedCreate = await cli(["create", dataFile]);
	expect(failedCreate.code).toBe(3);
	expect(failedCreate.out).toBe("");
	expect(failedCreate.error).toMatch(/Request ID: [0-9a-f-]{36}/);
	expect(
		(await cli(["stop", receipt.taskId, String(receipt.revision), "cancel"]))
			.code,
	).toBe(0);
	expect((await client.workTask(receipt.taskId)).task.state).toBe("cancelled");
	expect((await cli(["start", receipt.taskId, "-1"])).code).toBe(2);
});
test("delegated feature flag is strict, and disabled execution still permits registration", async () => {
	// The flag itself (default off, strict values) is covered by infrastructure/config.test.ts.
	expect(loadConfig({}).delegatedTasksEnabled).toBe(false);
	expect(() =>
		loadConfig({ EUMENES_DELEGATED_TASKS_ENABLED: "maybe" }),
	).toThrow("config_invalid:EUMENES_DELEGATED_TASKS_ENABLED");
	const h = setup({ disabled: true });
	const r = await h.tasks.create(input("register_only"));
	await expect(h.tasks.start(r.taskId, cmd(r.revision))).rejects.toThrow(
		"task_execution_unavailable",
	);
});

test("a full Queue cannot discard a cancellation; maintenance dispatches the saved stop intent when capacity returns", async () => {
	let release = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = setup({ queueLimit: 1, dispatchGate: gate });
	const r = await h.tasks.create(input());
	await h.queue.tick();
	await until(() => h.calls.dispatch === 1);
	const stop = await h.tasks.stop(r.taskId, {
		...cmd(h.tasks.get(r.taskId).task.revision),
		intent: "cancel",
	});
	expect(stop.state).toBe("stopping");
	expect(jobs(h, "tasks.stop.v1")).toHaveLength(0);
	release();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "cancelled");
	await h.tasks.maintenance();
	await h.queue.tick();
	await until(() => h.tasks.get(r.taskId).task.state === "cancelled");
	expect(h.calls.stop).toBe(1);
});
test("late observation after cancellation cannot revive the task or alter its business revision", async () => {
	const h = setup(),
		r = await h.tasks.create(input());
	await h.queue.tick();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "completed");
	h.calls.blockedObservation = true;
	h.clock.t += 60_000;
	await h.scheduler.tick();
	await h.queue.tick();
	await until(() => h.calls.observe === 1);
	await h.tasks.stop(r.taskId, {
		...cmd(h.tasks.get(r.taskId).task.revision),
		intent: "cancel",
	});
	await h.queue.tick();
	await until(() => h.tasks.get(r.taskId).task.state === "cancelled");
	const revision = h.tasks.get(r.taskId).task.revision;
	h.release();
	await until(() => jobs(h, "tasks.observe.v1")[0]?.state === "cancelled");
	expect(h.tasks.get(r.taskId).task.revision).toBe(revision);
});

test("observation backlog schedules the next bounded batch without waiting for the next minute", async () => {
	const h = setup({ backlogBatches: 2 });
	const r = await h.tasks.create(input());
	await h.queue.tick();
	await until(() => jobs(h, "tasks.dispatch.v1")[0]?.state === "completed");
	h.clock.t += 60_000;
	await h.scheduler.tick();
	for (let count = 0; count < 3; count++) {
		await h.queue.tick();
		await until(
			() =>
				jobs(h, "tasks.observe.v1").filter((j) => j.state === "completed")
					.length >=
				count + 1,
		);
	}
	expect(h.calls.observe).toBe(3);
	expect(jobs(h, "tasks.observe.v1")).toHaveLength(3);
	expect(h.tasks.get(r.taskId).task.state).toBe("active");
});

test("async execution preparation rolls back the task, dispatch job and monitor together", async () => {
	const h = setup({
		prepareResult: async () => {
			await Promise.resolve();
			throw new Error("late preparation failure");
		},
	});
	await expect(h.tasks.create(input())).rejects.toThrow(
		"task_async_preparation_forbidden",
	);
	await Bun.sleep(0);
	expect(h.tasks.list().items).toHaveLength(0);
	expect(h.queue.list().items).toHaveLength(0);
	expect(h.scheduler.list().items).toHaveLength(0);
});
