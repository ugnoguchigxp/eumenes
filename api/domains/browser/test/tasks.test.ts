import { afterEach, expect, test } from "bun:test";
import type { TaskStepRunner } from "../service";
import {
	OWNER,
	WEB,
	connect,
	parkedRunner,
	runCleanup,
	setup,
	until,
	type Env,
} from "./fakes";

afterEach(runCleanup);
const input = (
	tabRef: string | undefined,
	extra: Record<string, unknown> = {},
) => ({
	owner: OWNER,
	conversationId: "main",
	origin: "conversation" as const,
	requestId: crypto.randomUUID(),
	request: "設定ページを開いて",
	tabRef,
	...extra,
});
const ended = (env: Env, id: string) =>
	until(
		() =>
			!["queued", "running"].includes(env.service.taskStatus(OWNER, id).state),
	);

test("a task needs the step runner, a live connection, a known tab and an allowed URL", async () => {
	const bare = setup();
	await bare.service.ready;
	await expect(bare.service.startTask(input(undefined))).rejects.toThrow(
		"browser_task_runner_missing",
	);
	const env = setup({ runTaskStep: parkedRunner });
	await env.service.ready;
	await expect(env.service.startTask(input(undefined))).rejects.toThrow(
		"browser_disconnected",
	);
	const tabRef = await connect(env);
	await expect(
		env.service.startTask(input(crypto.randomUUID())),
	).rejects.toThrow("tab_lost");
	await expect(
		env.service.startTask(input(tabRef, { url: "file:///etc/hosts" })),
	).rejects.toThrow("navigation_scheme_blocked");
	await expect(
		env.service.startTask(input(tabRef, { request: "  " })),
	).rejects.toThrow("invalid_browser_request");
});

test("each model step is one queue job; the core state is stored as JSON and handed to the next step", async () => {
	const seen: unknown[] = [];
	const runner: TaskStepRunner = async (step) => {
		seen.push({
			step: step.step,
			core: step.coreState,
			frozen: step.frozen,
			tabRef: step.tabRef,
		});
		if (step.step < 3)
			return { kind: "continue", coreState: { calls: step.step } };
		return {
			kind: "done",
			state: "completed",
			coreState: { calls: 3 },
			text: "設定ページを開きました。",
		};
	};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const accepted = await env.service.startTask(
		input(tabRef, {
			frozen: { package: "browser.page-operator@1" },
			coreState: { calls: 0 },
		}),
	);
	expect(accepted.state).toBe("queued");
	await ended(env, accepted.taskId);
	const frozen = { package: "browser.page-operator@1" };
	expect(seen).toEqual([
		{ step: 1, core: { calls: 0 }, frozen, tabRef },
		{ step: 2, core: { calls: 1 }, frozen, tabRef },
		{ step: 3, core: { calls: 2 }, frozen, tabRef },
	]);
	const done = env.service.taskStatus(OWNER, accepted.taskId);
	expect(done).toMatchObject({
		state: "completed",
		resultSummary: "設定ページを開きました。",
	});
	expect(
		JSON.parse(env.service.taskRow(accepted.taskId)!.core_state_json!),
	).toEqual({ calls: 3 });
	expect(env.notices).toEqual([
		expect.objectContaining({
			id: `browser-task:${accepted.taskId}:completed`,
			conversationId: "main",
			message: "設定ページを開きました。",
		}),
	]);
});

test("the runner acts through the task's api: observe, operate, grants and captures", async () => {
	const runner: TaskStepRunner = async (step, { api }) => {
		const o = await api.observe(step.tabRef!);
		const g = await api.grantFromRequest({
			value: "設定",
			quote: "設定ページ",
			origin: WEB,
			purpose: "search",
		});
		await api.operate(step.tabRef!, {
			kind: "type",
			observationRef: o.observationRef,
			ref: "e2",
			element: "box",
			inputValueRef: g.inputValueRef,
			purpose: "search",
			submit: true,
		});
		const shot = await api.capture({ tabRef: step.tabRef!, range: "viewport" });
		await until(
			() => api.captureStatus(shot.captureId).state === "local_ready",
		);
		return {
			kind: "done",
			state: "completed",
			coreState: { shot: shot.captureId },
			text: "入力して撮影しました。",
		};
	};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const t = await env.service.startTask(input(tabRef));
	await ended(env, t.taskId);
	const status = env.service.taskStatus(OWNER, t.taskId);
	expect(status.state).toBe("completed");
	expect(status.operations).toMatchObject([
		{ toolKind: "type", state: "observed" },
	]);
	const { shot } = JSON.parse(env.service.taskRow(t.taskId)!.core_state_json!);
	await until(
		() => env.service.captureStatus(OWNER, shot).state === "local_ready",
	);
	// The tab is released with the task.
	expect(env.service.tabs()[0]!.status).toBe("idle");
});

test("needs_input and failed endings carry their text and code", async () => {
	let n = 0;
	const runner: TaskStepRunner = async () =>
		++n === 1
			? {
					kind: "done",
					state: "needs_input",
					coreState: {},
					text: "どの項目を開きますか？",
				}
			: {
					kind: "done",
					state: "failed",
					coreState: {},
					text: "x",
					errorCode: "turn_limit",
				};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const a = await env.service.startTask(input(tabRef));
	await ended(env, a.taskId);
	expect(env.service.taskStatus(OWNER, a.taskId)).toMatchObject({
		state: "needs_input",
		resultSummary: "どの項目を開きますか？",
	});
	const b = await env.service.startTask(input(tabRef));
	await ended(env, b.taskId);
	expect(env.service.taskStatus(OWNER, b.taskId)).toMatchObject({
		state: "failed",
		errorCode: "turn_limit",
	});
	expect(env.notices.at(-1)!.message).toContain(
		"ブラウザの操作を完了できませんでした",
	);
});

test("a runner that throws ends the task as failed with a safe code", async () => {
	const runner: TaskStepRunner = async () => {
		throw new Error("SECRET token=abc");
	};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const t = await env.service.startTask(input(tabRef));
	await ended(env, t.taskId);
	expect(env.service.taskStatus(OWNER, t.taskId)).toMatchObject({
		state: "failed",
		errorCode: "browser_task_failed",
	});
	expect(JSON.stringify(env.notices)).not.toContain("SECRET");
});

test("the same request starts one task and a changed one conflicts", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const base = input(tabRef);
	const a = await env.service.startTask(base);
	expect((await env.service.startTask(base)).taskId).toBe(a.taskId);
	await expect(
		env.service.startTask({ ...base, request: "別の依頼" }),
	).rejects.toThrow("request_conflict");
	for (let i = 0; i < 2; i++) await env.service.startTask(input(tabRef));
	await expect(env.service.startTask(input(tabRef))).rejects.toThrow(
		"browser_capacity",
	);
});

test("cancelling aborts the running step and nothing runs after it", async () => {
	let aborted = false;
	let calls = 0;
	const runner: TaskStepRunner = async (_step, { signal }) => {
		calls++;
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve()),
		);
		aborted = true;
		return { kind: "continue", coreState: {} };
	};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const t = await env.service.startTask(input(tabRef));
	await until(() => calls === 1);
	const view = await env.service.cancelTask(OWNER, t.taskId);
	expect(view.state).toBe("cancelled");
	await until(() => aborted);
	await Bun.sleep(40);
	expect(calls).toBe(1);
	expect(env.service.taskStatus(OWNER, t.taskId).state).toBe("cancelled");
	// A cancelled task is quiet: the user asked for it.
	expect(env.notices).toEqual([]);
	await expect(
		env.service.cancelTask("someone-else", t.taskId),
	).rejects.toThrow("browser_task_not_found");
});

test("a task past its deadline expires, announces it and refuses further operations", async () => {
	let clock = Date.now();
	const env = setup({
		runTaskStep: parkedRunner,
		taskMs: 1000,
		now: () => clock,
	});
	const tabRef = await connect(env);
	const t = await env.service.startTask(input(tabRef));
	await until(() => env.service.taskRow(t.taskId)!.state === "running");
	clock += 1500;
	expect((await env.service.sweep()).tasks).toEqual([t.taskId]);
	expect(env.service.taskStatus(OWNER, t.taskId)).toMatchObject({
		state: "expired",
		errorCode: "task_expired",
	});
	expect(env.notices.map((n) => n.id)).toEqual([
		`browser-task:${t.taskId}:expired`,
	]);
	await expect(
		env.service.operate({
			owner: OWNER,
			taskId: t.taskId,
			tabRef,
			action: { kind: "back" },
		}),
	).rejects.toThrow("task_not_active");
});

test("losing the connection fails a task that had nothing in flight", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const t = await env.service.startTask(input(tabRef));
	await until(() => env.service.taskRow(t.taskId)!.state === "running");
	await env.service.disconnect();
	expect(env.service.taskStatus(OWNER, t.taskId)).toMatchObject({
		state: "failed",
		errorCode: "browser_disconnected",
	});
});

test("the screen's source reports availability, tabs, tasks and captures with a changing revision", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const read = () =>
		env.store.read((db) => env.service.sourceInTransaction(db, OWNER));
	const before = read();
	expect(before.data.availability).toEqual({
		available: false,
		reason: "browser_not_configured",
	});
	const tabRef = await connect(env);
	const connected = read();
	expect(connected.data.availability).toEqual({ available: true });
	expect(connected.revision).not.toBe(before.revision);
	await env.service.startTask(input(tabRef));
	const withTask = read();
	expect(withTask.data.tasks).toHaveLength(1);
	expect(withTask.revision).not.toBe(connected.revision);
	expect(env.service.availability()).toEqual({ available: true });
});
