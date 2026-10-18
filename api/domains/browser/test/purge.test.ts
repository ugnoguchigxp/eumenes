import { afterEach, expect, test } from "bun:test";
import { BrowserApprovalRequired } from "../contracts";
import type { TaskStepRunner } from "../service";
import {
	OWNER,
	WEB,
	connect,
	parkedRunner,
	runCleanup,
	setup,
	startRunningTask,
	until,
	type Env,
} from "./fakes";

afterEach(runCleanup);
const rows = (env: Env, sql: string) =>
	env.store.read((db) => db.query(sql).all()) as Record<string, unknown>[];
const count = (env: Env, table: string) =>
	(rows(env, `SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n;

test("every way a task ends erases its saved core state; a runner's light end state is kept as given", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const cancelled = await startRunningTask(env, tabRef);
	await until(
		() => env.service.taskRow(cancelled)?.core_state_json === '{"parked":true}',
	);
	await env.service.cancelTask(OWNER, cancelled);
	expect(env.service.taskRow(cancelled)!.core_state_json).toBeNull();

	const expiring = await startRunningTask(env, tabRef);
	await until(
		() => env.service.taskRow(expiring)?.core_state_json === '{"parked":true}',
	);
	await env.store.write((db) =>
		db.query("UPDATE browser_tasks SET deadline=1 WHERE id=?").run(expiring),
	);
	await env.service.sweep();
	expect(env.service.taskRow(expiring)!.state).toBe("expired");
	expect(env.service.taskRow(expiring)!.core_state_json).toBeNull();

	const lost = await startRunningTask(env, tabRef);
	await until(
		() => env.service.taskRow(lost)?.core_state_json === '{"parked":true}',
	);
	await env.service.disconnect();
	expect(env.service.taskRow(lost)!.state).toBe("failed");
	expect(env.service.taskRow(lost)!.core_state_json).toBeNull();

	const runner: TaskStepRunner = async () => ({
		kind: "done",
		state: "completed",
		coreState: { light: true },
		text: "ok",
	});
	const finishing = setup({ runTaskStep: runner });
	const t2 = await connect(finishing);
	const done = await finishing.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		requestId: crypto.randomUUID(),
		request: "x",
		tabRef: t2,
	});
	await until(
		() =>
			finishing.service.taskStatus(OWNER, done.taskId).state === "completed",
	);
	expect(finishing.service.taskRow(done.taskId)!.core_state_json).toBe(
		'{"light":true}',
	);
});

test("typed values and approval values are erased when the task ends or the approval expires", async () => {
	let clock = Date.now();
	const env = setup({ runTaskStep: parkedRunner, now: () => clock });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(
		env,
		tabRef,
		"検索欄に hello と入力して",
	);
	await env.service.grantFromRequest(OWNER, taskId, {
		value: "hello",
		quote: "hello",
		origin: WEB,
		purpose: "search",
	});
	await env.service.grantUserApproved(OWNER, taskId, {
		value: "typed by the user",
		origin: WEB,
		purpose: "search",
	});
	expect(
		rows(env, "SELECT value FROM browser_input_grants").map((r) => r.value),
	).toEqual(["hello", "typed by the user"]);
	await env.service.cancelTask(OWNER, taskId);
	expect(
		rows(env, "SELECT value, revoked_at FROM browser_input_grants"),
	).toEqual([
		{ value: null, revoked_at: expect.any(Number) },
		{ value: null, revoked_at: expect.any(Number) },
	]);

	// A pending value approval is erased when it expires, without anyone answering it.
	const runner: TaskStepRunner = async () => ({
		kind: "done",
		state: "needs_input",
		coreState: null,
		text: "?",
		approvals: [
			{
				kind: "input_value",
				value: "secret value",
				origin: WEB,
				purpose: "login",
			},
		],
	});
	const asking = setup({ runTaskStep: runner, now: () => clock });
	const t = await connect(asking);
	const task = await asking.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		requestId: crypto.randomUUID(),
		request: "x",
		tabRef: t,
	});
	await until(
		() => asking.service.taskStatus(OWNER, task.taskId).state === "needs_input",
	);
	expect(rows(asking, "SELECT status, value FROM browser_approvals")).toEqual([
		{ status: "pending", value: "secret value" },
	]);
	clock += 10 * 60_000 + 1;
	await asking.service.sweep();
	expect(rows(asking, "SELECT status, value FROM browser_approvals")).toEqual([
		{ status: "expired", value: null },
	]);
});

test("a finished task's operations keep only the page's origin and path", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await env.service.operate({
		owner: OWNER,
		taskId,
		tabRef,
		action: {
			kind: "navigate",
			url: "https://example.com/p?q=secret&token=1#frag",
		},
	});
	const [op] = rows(env, "SELECT result_url FROM browser_operations");
	expect(op).toEqual({ result_url: "https://example.com/p" });
});

test("sweep deletes what ended more than 7 days ago and keeps active work", async () => {
	let clock = Date.now();
	const asked: TaskStepRunner = async (step, { api }) => {
		const o = await api.observe(step.tabRef!);
		try {
			await api.operate(step.tabRef!, {
				kind: "click",
				observationRef: o.observationRef,
				ref: "e2",
				element: "Send",
				effect: "commit",
			});
		} catch (e) {
			if (e instanceof BrowserApprovalRequired)
				return {
					kind: "done",
					state: "needs_input",
					coreState: null,
					text: "?",
					approvals: [e.request],
				};
			throw e;
		}
		return { kind: "done", state: "completed", coreState: null, text: "" };
	};
	const env = setup({ runTaskStep: asked, now: () => clock });
	const tabRef = await connect(env);
	const old = await env.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		requestId: crypto.randomUUID(),
		request: "x",
		tabRef,
	});
	await until(() => env.service.taskRow(old.taskId)?.state === "needs_input");
	await env.store.write((db) =>
		db
			.query(
				"INSERT INTO browser_input_grants(id,task_id,origin,purpose,provenance,value,expires_at,created_at) VALUES('g',?,?,'p','request',NULL,1,1)",
			)
			.run(old.taskId, WEB),
	);
	expect(count(env, "browser_input_grants")).toBe(1);
	expect(count(env, "browser_tasks")).toBe(1);
	expect(count(env, "browser_approvals")).toBe(1);
	expect(count(env, "browser_operations")).toBeGreaterThan(0);
	clock += 6 * 24 * 60 * 60_000;
	await env.service.sweep();
	expect(count(env, "browser_tasks")).toBe(1);
	clock += 2 * 24 * 60 * 60_000;
	await env.service.sweep();
	expect(count(env, "browser_tasks")).toBe(0);
	expect(count(env, "browser_approvals")).toBe(0);
	expect(count(env, "browser_operations")).toBe(0);
	expect(count(env, "browser_input_grants")).toBe(0);
});

test("an exception after the operation was sent makes it indeterminate and stops the task, never a retryable refusal", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	let release!: () => void;
	env.driver.actGate = new Promise<void>((r) => (release = r));
	const pending = env.service
		.operate({ owner: OWNER, taskId, tabRef, action: { kind: "back" } })
		.catch((e) => e as Error);
	await until(() => env.driver.calls.includes("act:back"));
	// The settling write fails once, as a full disk or a lock timeout would.
	const write = env.store.write.bind(env.store);
	let broken = true;
	env.store.write = ((fn: Parameters<typeof write>[0]) => {
		if (broken) {
			broken = false;
			return Promise.reject(new Error("disk full"));
		}
		return write(fn);
	}) as typeof env.store.write;
	release();
	const error = await pending;
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe("operation_indeterminate");
	expect(rows(env, "SELECT state, error_code FROM browser_operations")).toEqual(
		[{ state: "indeterminate", error_code: "operation_indeterminate" }],
	);
	expect(env.service.taskRow(taskId)!.state).toBe("indeterminate");
	expect(env.service.taskRow(taskId)!.core_state_json).toBeNull();
});
