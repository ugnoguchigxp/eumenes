import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createKanban,
	migrations as kanbanMigrations,
	readWorkspaceGuard,
	type KanbanExecutor,
} from "../../domains/kanban";
import {
	createCodexTasks,
	migrations as codexMigrations,
} from "../../domains/codex-tasks";
import { sdkRunnerClient } from "../../domains/coding";
import { SdkService } from "../../../packages/coding-runner/src/sdk-service";
import { serveSdk } from "../../../packages/coding-runner/src/sdk-server";
import type { SdkEngine } from "../../../packages/coding-runner/src/sdk-engine";
import { createKanbanExecutorRegistry } from "./kanban-executors";
import {
	createCodexTaskPort,
	adoptCodexTaskInTransaction,
} from "./codex-task-port";
import { connectCodexTaskRunner } from "./codex-task-runner";
import { waitFor } from "../../infrastructure/wait-for";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const report = {
	outcome: "done" as const,
	summary: "fixture done",
	verification: [],
	files: [],
	unconfirmed: [],
	blocker: "",
};
async function fixture(engine: SdkEngine) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cxt-")));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const store = openStore(join(root, "db.sqlite"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...kanbanMigrations,
		...codexMigrations,
	]);
	const tasks = createCodexTasks({ store });
	const sdk = new SdkService(
		{
			root: join(root, "spool"),
			workspaces: { fixture: workspace },
			protectedPaths: [],
		},
		engine,
	);
	const host = await serveSdk(sdk);
	const client = sdkRunnerClient(host.socket);
	const definition: KanbanExecutor = {
		id: "codex",
		revision: 1,
		label: "Codex",
		available: true,
		workspaceRef: "shared",
		sessionPolicy: "executor-created",
		capabilities: {
			terminal: false,
			activity: true,
			commit: false,
			push: false,
			commitPush: false,
		},
	};
	const model = crypto.randomUUID();
	const port = createCodexTaskPort({
		tasks,
		definition: () => definition,
		contextInTransaction: () => ({
			scope: "board",
			workerRevision: "profile:fixture@1",
			workerInstruction:
				"Execute the fixture request and report actual verification.",
			settingsRevision: 1,
			runnerId: "fixture",
			workspaceId: "fixture",
			model,
			deadlineMs: 60_000,
		}),
		stop: async () => "unconfirmed",
	});
	const registry = createKanbanExecutorRegistry([port]);
	const kanban = createKanban({ store, executors: registry.definitions });
	let failAdoption = false;
	function connect() {
		return connectCodexTaskRunner({
			store,
			tasks,
			runner: () => client,
			adoptInTransaction: (tx, attempt) => {
				if (failAdoption && attempt.receipt?.state === "succeeded") {
					failAdoption = false;
					throw new Error("fixture_adoption_failure");
				}
				const adopted = adoptCodexTaskInTransaction(
					tx,
					kanban,
					definition.id,
					attempt,
				);
				if (adopted?.dispatch)
					registry.enqueueInTransaction(tx, kanban, adopted.dispatch);
			},
		});
	}
	const links: ReturnType<typeof connect>[] = [];
	cleanup.push(async () => {
		for (const link of links) await link.disconnect();
		await host.close();
		await store.close();
		rmSync(root, { recursive: true, force: true });
	});
	const board = () =>
		store.readSnapshot((tx) =>
			kanban.sharedBoardInTransaction(tx, { runnable: true }),
		);
	let request = 0;
	async function add(title: string) {
		return (
			await store.write((tx) =>
				kanban.addInTransaction(
					tx,
					{ title, prompt: title, executorId: definition.id },
					`add-${++request}`,
				),
			)
		).receipt;
	}
	async function run(cardId: string) {
		return store.write((tx) => {
			const out = kanban.runInTransaction(
				tx,
				{
					cardId,
					expectedRevision: kanban.cardInTransaction(tx, cardId, {
						runnable: true,
					})!.revision,
				},
				`run-${++request}`,
				{ origin: "board", runnable: true },
			);
			if (out.dispatch) registry.enqueueInTransaction(tx, kanban, out.dispatch);
			return out;
		});
	}
	return {
		store,
		tasks,
		sdk,
		client,
		registry,
		kanban,
		add,
		run,
		board,
		model,
		failOnce: () => {
			failAdoption = true;
		},
		connect: () => {
			const link = connect();
			links.push(link);
			return link;
		},
	};
}
async function eventually(
	check: () => boolean,
	action: () => Promise<unknown>,
) {
	await waitFor(async () => {
		if (check()) return true;
		await action();
		return false;
	});
}

test("backend port disconnect/reconnect adopts the same SDK execution, thread and one notification", async () => {
	let calls = 0;
	let finish: () => void = () => {};
	const h = await fixture(async ({ onThread, onActivity }) => {
		calls++;
		onThread("native-thread");
		onActivity({ type: "turn.started" });
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: true };
	});
	const card = await h.add("work");
	const link = h.connect();
	const started = await h.run(card.cardId);
	await eventually(
		() => h.board().runs[0]?.state === "running",
		() => link.flush(),
	);
	const before = await h.client.inspect(started.receipt.runId!);
	await link.disconnect();
	finish();
	await eventually(
		() => h.sdk.store.read(started.receipt.runId!)?.state === "succeeded",
		async () => {},
	);
	const reconnected = h.connect();
	await eventually(
		() => h.board().cards[0]?.label === "done",
		() => reconnected.flush(),
	);
	expect(calls).toBe(1);
	expect(h.board().runs[0]).toMatchObject({
		state: "completed",
		sessionRef: "native-thread",
		executionStopped: true,
	});
	expect((await h.client.inspect(started.receipt.runId!)).epoch).toBe(
		before.epoch,
	);
	expect(
		h.kanban.notices(10).notices.filter((notice) => notice.kind === "done"),
	).toHaveLength(1);
	expect(h.tasks.pending()).toEqual([]);
	expect(
		h.store.readSnapshot((tx) => readWorkspaceGuard(tx, "shared")),
	).toBeNull();
});

test("failed shared adoption rolls back the final result and retries observation without rerunning SDK", async () => {
	let calls = 0;
	const h = await fixture(async ({ onThread, onActivity }) => {
		calls++;
		onThread("native-thread");
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: true };
	});
	const card = await h.add("work");
	h.failOnce();
	const link = h.connect();
	const started = await h.run(card.cardId);
	await eventually(
		() => h.sdk.store.read(started.receipt.runId!)?.state === "succeeded",
		() => link.flush(),
	);
	await link.flush();
	await eventually(
		() => h.board().cards[0]?.label === "done",
		() => link.flush(),
	);
	expect(calls).toBe(1);
	expect(
		h.kanban.notices(10).notices.filter((notice) => notice.kind === "done"),
	).toHaveLength(1);
});

test("managed termination advances same workspace FIFO; a follow-up resumes only its own saved thread", async () => {
	const threads: (string | undefined)[] = [];
	const h = await fixture(async ({ spec, onThread, onActivity }) => {
		threads.push(spec.threadId);
		onThread("native-thread");
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: true };
	});
	const first = await h.add("first");
	const other = await h.add("other");
	const link = h.connect();
	await h.run(first.cardId);
	await h.run(other.cardId);
	await eventually(
		() =>
			h.board().cards.find((card) => card.id === first.cardId)?.label ===
			"done",
		() => link.flush(),
	);
	await eventually(
		() =>
			h.board().cards.find((card) => card.id === other.cardId)?.label ===
			"done",
		() => link.flush(),
	);
	expect(threads).toEqual([undefined, undefined]);
	await h.store.write((tx) => {
		const current = h.kanban.cardInTransaction(tx, first.cardId, {
			runnable: true,
		})!;
		const out = h.kanban.followupInTransaction(
			tx,
			{
				cardId: current.id,
				expectedRevision: current.revision,
				note: "follow-up",
			},
			"followup",
			{ origin: "board", runnable: true },
		);
		if (out.dispatch)
			h.registry.enqueueInTransaction(tx, h.kanban, out.dispatch);
	});
	await eventually(
		() =>
			threads.length === 3 &&
			h.board().runs.find((run) => run.cardId === first.cardId)?.state ===
				"completed",
		() => link.flush(),
	);
	expect(threads).toEqual([undefined, undefined, "native-thread"]);
});

test("unconfirmed native termination adopts unknown and retains the workspace guard", async () => {
	const h = await fixture(async ({ onThread, onActivity }) => {
		onThread("native-thread");
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: false };
	});
	const card = await h.add("unknown work");
	const link = h.connect();
	await h.run(card.cardId);
	await eventually(
		() => h.board().runs[0]?.state === "unknown",
		() => link.flush(),
	);
	expect(h.board().cards[0]!.label).toBe("blocker");
	expect(h.board().queues[0]!.state).toBe("paused");
	expect(
		h.store.readSnapshot((tx) => readWorkspaceGuard(tx, "shared"))?.state,
	).toBe("unknown");
});

test("unchanged active observations do not publish board changes; new terminal facts still settle", async () => {
	let finish: () => void = () => {};
	const h = await fixture(async ({ onThread, onActivity }) => {
		onThread("native-thread");
		onActivity({ type: "turn.started" });
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: true };
	});
	const card = await h.add("steady work");
	const link = h.connect();
	await h.run(card.cardId);
	await eventually(
		() => h.board().runs[0]?.state === "running",
		() => link.flush(),
	);
	await link.flush();
	const revision = h.board().revision;
	let changes = 0;
	const unsubscribe = h.store.onCommit(() => {
		changes++;
	});
	try {
		for (let i = 0; i < 3; i++) await link.flush();
		expect(changes).toBe(0);
		expect(h.board().revision).toBe(revision);
	} finally {
		unsubscribe();
	}
	finish();
	await eventually(
		() => h.board().cards[0]?.label === "done",
		() => link.flush(),
	);
	expect(h.tasks.pending()).toEqual([]);
	expect(h.kanban.notices(10).notices).toHaveLength(1);
});
