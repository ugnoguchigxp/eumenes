import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { createQueue } from "../../queue";
import { createAgentRuntime } from "..";
import { harness } from "./route-harness";

afterEach(() => configureLogging({ level: "silent" }));

type H = Awaited<ReturnType<typeof harness>>;
const okResult = () => ({
	state: "succeeded" as const,
	result: {
		observedAt: new Date().toISOString(),
		hits: [],
		documents: [],
		failures: [],
	},
});
/** Starts a run whose worker waits on one tool invocation. */
async function waiting(h: H, runId: string) {
	await h.start(runId, "公開情報を調べて");
	const child = h.agents.list(runId).find((t) => t.kind === "worker")!;
	await h.runModelStep(child.id, {
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "公開情報" },
	});
	expect(h.task(child.id).state).toBe("waiting_tool");
	const inv = h.store.read(
		(db) =>
			db
				.query(
					"SELECT id, operation_id FROM tool_invocations WHERE owner_task_id=?",
				)
				.get(child.id) as { id: string; operation_id: string },
	);
	h.results.set(inv.operation_id, okResult());
	return { child, inv };
}
function failSettle(h: H, shouldFail: (invocationId: string) => Error | null) {
	const original = h.tools.settleInTransaction.bind(h.tools);
	h.tools.settleInTransaction = ((
		db: never,
		inv: { id: string },
		op: never,
	) => {
		const error = shouldFail(inv.id);
		if (error) throw error;
		return original(db, inv as never, op);
	}) as never;
}

test("a single settle failure does not abort the pass and is retried", async () => {
	const h = await harness();
	try {
		const a = await waiting(h, "run-a");
		const b = await waiting(h, "run-b");
		let once = true;
		failSettle(h, (id) => {
			if (id === a.inv.id && once) {
				once = false;
				return new Error("invocation_changed");
			}
			return null;
		});
		await h.agents.reconcile();
		expect(h.task(a.child.id).state).toBe("waiting_tool");
		expect(h.task(b.child.id).state).not.toBe("waiting_tool");
		await h.agents.reconcile();
		expect(h.task(a.child.id).state).not.toBe("waiting_tool");
	} finally {
		await h.close();
	}
});

test("a poisoned invocation fails its owner after five consecutive failures", async () => {
	const h = await harness();
	try {
		const a = await waiting(h, "run-a");
		failSettle(h, () => new Error("invocation_changed"));
		for (let i = 0; i < 5; i++) await h.agents.reconcile();
		const t = h.task(a.child.id);
		expect(t.state).toBe("failed");
		expect(t.error_code).toBe("reconcile_failed");
	} finally {
		await h.close();
	}
});

test("transient writer errors never count toward giving up", async () => {
	const h = await harness();
	try {
		const a = await waiting(h, "run-a");
		failSettle(h, () => new Error("database_closing"));
		for (let i = 0; i < 10; i++) await h.agents.reconcile();
		expect(h.task(a.child.id).state).toBe("waiting_tool");
	} finally {
		await h.close();
	}
});

test("close survives an in-flight reconcile failure and still interrupts the coordinator", async () => {
	const h = await harness();
	await waiting(h, "run-a");
	failSettle(h, () => new Error("invocation_changed"));
	let root: { state: string; error_code: string } | undefined;
	const originalClose = h.tools.close.bind(h.tools);
	h.tools.close = (() => {
		root = h.store.read(
			(db) =>
				db
					.query(
						"SELECT state, error_code FROM agent_tasks WHERE kind='coordinator' AND root_run_id='run-a'",
					)
					.get() as { state: string; error_code: string },
		);
		return originalClose();
	}) as never;
	const pending = h.agents.reconcile();
	await expect(h.close()).resolves.toBeUndefined();
	await pending.catch(() => {});
	expect(root?.state).toBe("interrupted");
	expect(root?.error_code).toBe("backend_stopped");
});

test("item failures are logged with a machine-readable reason", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "warn",
		destination: { write: (line) => void lines.push(line) },
	});
	const h = await harness();
	try {
		await waiting(h, "run-a");
		failSettle(h, () => new Error("invocation_changed"));
		await h.agents.reconcile();
		const entries = lines
			.map((l) => JSON.parse(l))
			.filter(
				(e) =>
					e.event === "agent.reconcile_item_failed" ||
					e.msg === "agent.reconcile_item_failed",
			);
		expect(entries.length).toBeGreaterThan(0);
		expect(JSON.stringify(entries[0])).toContain("invocation_changed");
	} finally {
		await h.close();
	}
});

test("commits right after a pass are throttled until the injected timer fires", async () => {
	const h = await harness();
	let clock = 1_000_000;
	let passes = 0;
	const tools = Object.create(h.tools) as typeof h.tools;
	tools.pending = ((cursor: string) => {
		passes++;
		return h.tools.pending(cursor);
	}) as never;
	const callbacks: Array<() => void> = [];
	const rt = createAgentRuntime({
		store: h.store,
		capabilities: h.caps,
		tools,
		inference: {} as never,
		queue: createQueue(h.store),
		now: () => clock,
		reconcileThrottleMs: 1000,
		timers: {
			setTimeout: ((fn: () => void) => {
				callbacks.push(fn);
				return { unref() {} } as never;
			}) as never,
			clearTimeout: (() => {}) as never,
		},
	});
	try {
		await h.store.write((db) => {
			db.query("CREATE TABLE throttle_probe(id INTEGER PRIMARY KEY)").run();
		});
		rt.start();
		await rt.reconcile();
		const settled = passes;
		expect(settled).toBeGreaterThan(0);
		callbacks.length = 0;
		for (let i = 0; i < 10; i++)
			await h.store.write((db) => {
				db.query("INSERT OR REPLACE INTO throttle_probe(id) VALUES(?)").run(i);
			});
		await Promise.resolve();
		expect(passes).toBe(settled);
		expect(callbacks).toHaveLength(1);
		clock += 1000;
		callbacks[0]!();
		await rt.reconcile();
		expect(passes).toBeGreaterThan(settled);
	} finally {
		await rt.close();
		await h.close();
	}
});
