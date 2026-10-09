import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore } from "../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../domains/queue";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../domains/scheduler";
import { migration as tasksMigration } from "../domains/tasks";
import { createCoding, migration as codingMigration } from "../domains/coding";
import { createDelegatedTasks } from "./delegated-tasks";
import { createCodingTaskExecution } from "./coding-tasks";
import { connectRunner } from "../../packages/coding-runner/src/client";
import { publishSpec } from "../../packages/coding-runner/src/core";
import { fixture, until } from "../../packages/coding-runner/test/support";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
	const f = fixture();
	cleanup.push(f.close);
	const store = openStore(join(f.root, "test.sqlite"), [
		queueMigration,
		schedulerMigration,
		tasksMigration,
		codingMigration,
	]);
	cleanup.push(() => store.close());
	const runner = await connectRunner({
		executable: process.execPath,
		serverPath: join(
			import.meta.dir,
			"../../packages/coding-runner/test/fixture-server.ts",
		),
		configPath: f.configPath,
	});
	cleanup.push(() => runner.close());
	const coding = createCoding({
		store,
		runner,
		publishSpec: (ref, spec) => publishSpec(f.config, ref, spec),
	});
	await store.write((db) =>
		coding.registerWorkspaceInTransaction(db, {
			id: "fixture",
			branch: "codex/fixture",
			available: true,
			reason: null,
		}),
	);
	const queue = createQueue(store);
	cleanup.push(() => queue.close(1000));
	const scheduler = createScheduler(store, queue);
	cleanup.push(() => scheduler.close());
	const port = createCodingTaskExecution({
		store,
		coding,
		tasks: () => delegated.tasks,
		available: true,
	});
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: true,
		execution: port.execution,
	});
	cleanup.push(delegated.close);
	const create = (branch = "codex/fixture") => ({
		requestId: crypto.randomUUID(),
		kind: "coding" as const,
		version: 1 as const,
		title: "Fixture",
		request: "normal",
		completionConditions: ["checked"],
		startMode: "start" as const,
		grant: {
			workspaceId: "fixture",
			branch,
			remote: null,
			operations: ["read", "edit"] as ["read", "edit"],
			network: "none" as const,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
	});
	return {
		f,
		store,
		coding,
		runner,
		queue,
		scheduler,
		delegated,
		port,
		create,
	};
}
test("task, Queue job, coding intent and workspace reservation commit together", async () => {
	const { store, delegated, coding, create } = await setup();
	await expect(delegated.tasks.create(create("codex/other"))).rejects.toThrow(
		"coding_branch_conflict",
	);
	expect(delegated.tasks.list().items).toHaveLength(0);
	const command = create();
	const t = await delegated.tasks.create(command);
	await delegated.tasks.create(command);
	expect(delegated.tasks.list().items).toHaveLength(1);
	expect(store.read((db) => coding.liveInTransaction(db))).toHaveLength(1);
	expect(
		store.read((db) => coding.latestInTransaction(db, t.taskId))?.state,
	).toBe("intent");
});
test("dispatch is short; finished CLI turn does not complete the user task", async () => {
	const { store, delegated, coding, queue, port, create } = await setup();
	const t = await delegated.tasks.create(create());
	queue.start();
	const e = await until(
		() => store.read((db) => coding.latestInTransaction(db, t.taskId)),
		(e) => e !== null && e.state !== "intent",
	);
	await until(
		() => coding.inspect(e!.id, 0, 100),
		(r) => r.receipt.childrenStopped,
	);
	await port.execution.observe(
		delegated.tasks.get(t.taskId).task,
		new AbortController().signal,
	);
	expect(delegated.tasks.get(t.taskId).task.state).toBe("active");
	expect(coding.get(e!.id).turnFinished).toBe(true);
	expect(coding.events(e!.id).events).toHaveLength(5);
});
test("cancel before Queue dispatch writes a durable negative start receipt", async () => {
	const { store, delegated, coding, queue, create, runner } = await setup();
	const t = await delegated.tasks.create(create());
	const stop = await delegated.tasks.stop(t.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		intent: "cancel",
	});
	expect(stop.state).toBe("stopping");
	queue.start();
	await until(
		() => delegated.tasks.get(t.taskId).task,
		(t) => t.state === "cancelled",
	);
	const e = store.read((db) => coding.latestInTransaction(db, t.taskId))!;
	const prepared = store.read((db) => {
		const spec = coding.specInTransaction(db, e.id);
		return coding.preparedInTransaction(db, spec.operationId);
	});
	expect((await runner.start(prepared.specRef, prepared.spec)).state).toBe(
		"stopped",
	);
	expect(coding.get(e.id).reason).toBe("stopped_before_spawn");
});
test("grant revocation rejects old event adoption and heartbeat stops the old execution", async () => {
	const { store, delegated, coding, queue, create, port } = await setup();
	const command = create();
	command.request = "long";
	const t = await delegated.tasks.create(command);
	queue.start();
	const e = await until(
		() => store.read((db) => coding.latestInTransaction(db, t.taskId)),
		(e) => e !== null && e.state !== "intent",
	);
	const old = delegated.tasks.get(t.taskId).task;
	await delegated.tasks.stop(t.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: old.revision,
		intent: "cancel",
	});
	await expect(
		port.execution.observe(old, new AbortController().signal),
	).rejects.toThrow("coding_authority_stale");
	await port.heartbeat();
	await until(
		() => coding.inspect(e!.id, 0, 100),
		(r) => r.receipt.childrenStopped,
	);
});

test("an inspect transport failure enters reconciliation and heartbeat revokes the blind execution", async () => {
	const { store, delegated, coding, queue, port, create } = await setup();
	const t = await delegated.tasks.create(create());
	queue.start();
	const e = await until(
		() => store.read((db) => coding.latestInTransaction(db, t.taskId)),
		(e) => e !== null && e.state !== "intent",
	);
	const inspect = coding.inspect;
	coding.inspect = async () => {
		throw new Error("runner_transport_unknown");
	};
	try {
		await expect(
			port.execution.observe(
				delegated.tasks.get(t.taskId).task,
				new AbortController().signal,
			),
		).rejects.toThrow("runner_transport_unknown");
		expect(delegated.tasks.get(t.taskId).task.state).toBe("reconciling");
		expect(coding.get(e!.id).state).toBe("outcome_unknown");
		expect(coding.get(e!.id).childrenStopped).toBe(false);
		await port.heartbeat();
	} finally {
		coding.inspect = inspect;
	}
	await until(
		() => inspect(e!.id, 0, 100),
		(r) => r.receipt.childrenStopped,
	);
});
test("a lease renewal racing cancellation is followed by revocation, and shutdown joins heartbeat", async () => {
	const { store, delegated, coding, queue, port, create } = await setup();
	const command = create();
	command.request = "long";
	const t = await delegated.tasks.create(command);
	queue.start();
	const e = await until(
		() => store.read((db) => coding.latestInTransaction(db, t.taskId)),
		(e) => e !== null && e.state !== "intent",
	);
	const inspect = coding.inspect;
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	coding.inspect = async (...args) => {
		if (args[3]) {
			entered();
			await barrier;
		}
		return inspect(...args);
	};
	try {
		const heartbeat = port.heartbeat();
		await ready;
		const active = delegated.tasks.get(t.taskId).task;
		await delegated.tasks.stop(t.taskId, {
			requestId: crypto.randomUUID(),
			expectedRevision: active.revision,
			intent: "cancel",
		});
		let closed = false;
		const shutdown = port.shutdown().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		await heartbeat;
		await shutdown;
		await port.heartbeat();
		const stopped = await until(
			() => inspect(e!.id, 0, 100),
			(r) => r.receipt.childrenStopped,
		);
		expect(stopped.receipt.state).toBe("stopped");
	} finally {
		release();
		coding.inspect = inspect;
	}
});
