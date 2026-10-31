import { afterEach, expect, test } from "bun:test";
import { BrowserApprovalRequired } from "../contracts";
import type { TargetInfo } from "../contracts/ports";
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

const POST_SUBMIT: TargetInfo = {
	tag: "button",
	type: "submit",
	inForm: true,
	formMethod: "post",
	submits: true,
};
const acts = (env: Env) =>
	env.driver.calls.filter((c) => c.startsWith("act:")).length;
const observe = (env: Env, tabRef: string, taskId: string) =>
	env.service.observe({ owner: OWNER, taskId, tabRef });
const operate = (env: Env, tabRef: string, taskId: string, action: unknown) =>
	env.service.operate({ owner: OWNER, taskId, tabRef, action });
async function click(
	env: Env,
	tabRef: string,
	taskId: string,
	extra: Record<string, unknown> = {},
) {
	const o = await observe(env, tabRef, taskId);
	return operate(env, tabRef, taskId, {
		kind: "click",
		observationRef: o.observationRef,
		ref: "e2",
		element: "Send",
		...extra,
	});
}
const approvalRows = (env: Env) =>
	env.store.read((db) =>
		db
			.query(
				"SELECT kind, status, task_id, value, url, action, element, value_digest, summary FROM browser_approvals ORDER BY created_at, rowid",
			)
			.all(),
	) as {
		kind: string;
		status: string;
		task_id: string;
		value: string | null;
		url: string;
		action: string;
		element: string;
		value_digest: string | null;
		summary: string;
	}[];

test("a click that submits a non-GET form needs approval and nothing is dispatched", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	env.driver.targetInfo = POST_SUBMIT;
	const error = await click(env, tabRef, taskId).catch((e) => e);
	expect(error).toBeInstanceOf(BrowserApprovalRequired);
	expect(error.code).toBe("approval_required");
	expect(error.request).toEqual({
		kind: "operation",
		tabRef,
		url: `${WEB}/`,
		action: "click",
		element: "Send",
		summary: expect.stringContaining("Send"),
	});
	expect(acts(env)).toBe(0);
	// Eumenes' own page: the click is a commit without inspecting the element (spec §4.4).
	expect(env.driver.calls.some((c) => c.startsWith("inspect"))).toBe(false);
	const op = env.store.read((db) =>
		db.query("SELECT state, error_code FROM browser_operations").get(),
	);
	expect(op).toEqual({ state: "failed", error_code: "approval_required" });
	// The task stays usable: nothing reached the page.
	expect(env.service.taskStatus(OWNER, taskId).state).toBe("running");
});

test("GET forms, dialog forms and links run without approval", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await operate(env, tabRef, taskId, {
		kind: "navigate",
		url: "https://example.com/",
	});
	env.driver.calls.length = 0;
	const open: TargetInfo[] = [
		{ ...POST_SUBMIT, formMethod: "get" },
		{ ...POST_SUBMIT, formMethod: "dialog" },
		{ tag: "a", inForm: false, submits: false },
		{ tag: "div", inForm: false, submits: false },
	];
	for (const info of open) {
		env.driver.targetInfo = info;
		expect(await click(env, tabRef, taskId)).toMatchObject({
			state: "observed",
		});
	}
	expect(acts(env)).toBe(open.length);
});

test("a button or role=button whose effect is unknown needs approval on every site", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await operate(env, tabRef, taskId, {
		kind: "navigate",
		url: "https://example.com/",
	});
	env.driver.calls.length = 0;
	const held: TargetInfo[] = [
		{ tag: "button", type: "button", inForm: false, submits: false },
		{
			tag: "button",
			type: "button",
			inForm: true,
			formMethod: "post",
			submits: false,
		},
		{ tag: "div", role: "button", inForm: false, submits: false },
	];
	for (const info of held) {
		env.driver.targetInfo = info;
		await expect(click(env, tabRef, taskId)).rejects.toBeInstanceOf(
			BrowserApprovalRequired,
		);
	}
	expect(acts(env)).toBe(0);
});

test("the model's own commit declaration needs approval without any inspection", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	env.driver.calls.length = 0;
	await expect(
		click(env, tabRef, taskId, { effect: "commit" }),
	).rejects.toBeInstanceOf(BrowserApprovalRequired);
	expect(env.driver.calls.some((c) => c.startsWith("inspect"))).toBe(false);
	expect(acts(env)).toBe(0);
});

test("pressing Enter or Space inspects the focused element; other keys do not", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	env.driver.targetInfo = POST_SUBMIT;
	const press = (key: string, extra: Record<string, unknown> = {}) =>
		operate(env, tabRef, taskId, { kind: "press", key, ...extra });
	await operate(env, tabRef, taskId, {
		kind: "navigate",
		url: "https://example.com/",
	});
	env.driver.calls.length = 0;
	await expect(press("Enter")).rejects.toBeInstanceOf(BrowserApprovalRequired);
	await expect(press("NumpadEnter")).rejects.toBeInstanceOf(
		BrowserApprovalRequired,
	);
	await expect(press("Space")).rejects.toBeInstanceOf(BrowserApprovalRequired);
	expect(acts(env)).toBe(0);
	expect(await press("Tab")).toMatchObject({ state: "observed" });
	expect(env.driver.calls.filter((c) => c === "inspectFocused")).toHaveLength(
		3,
	);
	// Enter in a GET form (a search box) goes through.
	env.driver.targetInfo = { ...POST_SUBMIT, formMethod: "get" };
	expect(await press("Enter")).toMatchObject({ state: "observed" });
	// A declared commit covers what only a script can submit.
	env.driver.targetInfo = { tag: "div", inForm: false, submits: false };
	await expect(press("Escape", { effect: "commit" })).rejects.toBeInstanceOf(
		BrowserApprovalRequired,
	);
});

const OUTSIDE_FORM: TargetInfo = {
	tag: "button",
	type: "button",
	inForm: false,
	submits: false,
};

test("a click on an Eumenes page needs approval even outside a form, and that approval is used once", async () => {
	const env = setup({ runTaskStep: sendRunner });
	const tabRef = await connect(env);
	env.driver.targetInfo = OUTSIDE_FORM;
	const first = await start(env, tabRef);
	await finished(env, first.taskId);
	expect(env.service.taskStatus(OWNER, first.taskId).state).toBe("needs_input");
	expect(env.driver.calls.some((c) => c.startsWith("inspect"))).toBe(false);
	expect(acts(env)).toBe(0);
	const second = await start(env, tabRef, {
		continueFrom: first.taskId,
		approvePending: true,
	});
	await finished(env, second.taskId);
	expect(env.service.taskStatus(OWNER, second.taskId).state).toBe("completed");
	expect(acts(env)).toBe(1);
	const third = await start(env, tabRef, {
		continueFrom: first.taskId,
		approvePending: true,
	});
	await finished(env, third.taskId);
	expect(env.service.taskStatus(OWNER, third.taskId).state).toBe("needs_input");
	expect(acts(env)).toBe(1);
});

test("Enter on an Eumenes page needs approval without inspection; reading the page does not", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await observe(env, tabRef, taskId);
	expect(env.service.tabs().length).toBeGreaterThan(0);
	await expect(
		operate(env, tabRef, taskId, { kind: "press", key: "Enter" }),
	).rejects.toBeInstanceOf(BrowserApprovalRequired);
	expect(env.driver.calls.some((c) => c === "inspectFocused")).toBe(false);
	expect(acts(env)).toBe(0);
});

test("typing with submit inspects the field; typing without submit does not", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(
		env,
		tabRef,
		"検索欄に hello world と入力して",
	);
	const grant = await env.service.grantFromRequest(OWNER, taskId, {
		value: "hello world",
		quote: "hello world",
		origin: WEB,
		purpose: "search",
	});
	const type = async (submit: boolean) => {
		const o = await observe(env, tabRef, taskId);
		return operate(env, tabRef, taskId, {
			kind: "type",
			observationRef: o.observationRef,
			ref: "e2",
			element: "Search box",
			inputValueRef: grant.inputValueRef,
			purpose: "search",
			submit,
		});
	};
	env.driver.targetInfo = {
		tag: "input",
		type: "text",
		inForm: true,
		formMethod: "post",
		submits: true,
	};
	expect(await type(false)).toMatchObject({ state: "observed" });
	expect(env.driver.calls.some((c) => c.startsWith("inspect"))).toBe(false);
	const error = await type(true).catch((e) => e);
	expect(error).toBeInstanceOf(BrowserApprovalRequired);
	expect(error.request).toMatchObject({
		action: "type",
		element: "Search box",
		valueDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
	});
	expect(error.request.summary).not.toContain("hello world");
});

test("a failing inspection stops the operation before it is sent", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	const { BrowserDriverError } = await import("../contracts/ports");
	env.driver.inspectError = new BrowserDriverError("ref_not_found", true);
	await operate(env, tabRef, taskId, {
		kind: "navigate",
		url: "https://example.com/",
	});
	env.driver.calls.length = 0;
	await expect(click(env, tabRef, taskId)).rejects.toThrow("ref_not_found");
	expect(acts(env)).toBe(0);
	const op = env.store.read((db) =>
		db.query("SELECT state FROM browser_operations").get(),
	);
	expect(op).toEqual({ state: "failed" });
});

/** A runner that clicks "Send" and reports what it needs approved when the host asks. */
const sendRunner: TaskStepRunner = async (step, { api }) => {
	const o = await api.observe(step.tabRef!);
	try {
		await api.operate(step.tabRef!, {
			kind: "click",
			observationRef: o.observationRef,
			ref: "e2",
			element: "Send",
		});
		return { kind: "done", state: "completed", coreState: null, text: "sent" };
	} catch (e) {
		if (e instanceof BrowserApprovalRequired)
			return {
				kind: "done",
				state: "needs_input",
				coreState: null,
				text: "送信してよいですか",
				approvals: [e.request],
			};
		throw e;
	}
};
const start = (env: Env, tabRef: string, extra: Record<string, unknown> = {}) =>
	env.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "送信して",
		tabRef,
		...extra,
	});
const finished = (env: Env, id: string) =>
	until(
		() =>
			!["queued", "running"].includes(env.service.taskStatus(OWNER, id).state),
	);

test("a task that ends needs_input stores pending approvals; a follow-up that approves moves them and the operation runs once", async () => {
	const env = setup({ runTaskStep: sendRunner });
	const tabRef = await connect(env);
	env.driver.targetInfo = POST_SUBMIT;
	const first = await start(env, tabRef);
	expect(first.approved).toEqual([]);
	await finished(env, first.taskId);
	expect(env.service.taskStatus(OWNER, first.taskId).state).toBe("needs_input");
	expect(approvalRows(env)).toMatchObject([
		{
			kind: "operation",
			status: "pending",
			task_id: first.taskId,
			url: `${WEB}/`,
		},
	]);
	expect(acts(env)).toBe(0);

	const second = await start(env, tabRef, {
		continueFrom: first.taskId,
		approvePending: true,
	});
	expect(second.approved).toMatchObject([
		{ kind: "operation", action: "click", element: "Send", tabRef },
	]);
	await finished(env, second.taskId);
	expect(env.service.taskStatus(OWNER, second.taskId).state).toBe("completed");
	expect(acts(env)).toBe(1);
	expect(approvalRows(env)[0]).toMatchObject({
		status: "consumed",
		task_id: second.taskId,
	});

	// Used once: a third task that tries to reuse the first one's approval gets nothing.
	const third = await start(env, tabRef, {
		continueFrom: first.taskId,
		approvePending: true,
	});
	expect(third.approved).toEqual([]);
	await finished(env, third.taskId);
	expect(env.service.taskStatus(OWNER, third.taskId).state).toBe("needs_input");
	expect(acts(env)).toBe(1);
});

test("without approvePending, from another conversation or owner, or after 10 minutes nothing moves", async () => {
	let clock = Date.now();
	const env = setup({ runTaskStep: sendRunner, now: () => clock });
	const tabRef = await connect(env);
	env.driver.targetInfo = POST_SUBMIT;
	const ask = async () => {
		const t = await start(env, tabRef);
		await finished(env, t.taskId);
		return t.taskId;
	};
	const a = await ask();
	const declined = await start(env, tabRef, { continueFrom: a });
	expect(declined.approved).toEqual([]);
	await finished(env, declined.taskId);
	const elsewhere = await start(env, tabRef, {
		continueFrom: a,
		approvePending: true,
		conversationId: "other",
	});
	expect(elsewhere.approved).toEqual([]);
	await finished(env, elsewhere.taskId);
	const stranger = await start(env, tabRef, {
		continueFrom: a,
		approvePending: true,
		owner: "someone-else",
	});
	expect(stranger.approved).toEqual([]);
	await until(
		() => env.service.taskRow(stranger.taskId)?.state === "needs_input",
	);
	expect(acts(env)).toBe(0);
	expect(approvalRows(env).filter((r) => r.task_id === a)).toMatchObject([
		{ status: "pending" },
	]);
	clock += 10 * 60_000 + 1000;
	const late = await start(env, tabRef, {
		continueFrom: a,
		approvePending: true,
	});
	// (The clock is ahead of the queue's, so this task's step is not due; the move is decided at start.)
	expect(late.approved).toEqual([]);
	expect(approvalRows(env).filter((r) => r.task_id === a)).toMatchObject([
		{ status: "pending" },
	]);
	expect(acts(env)).toBe(0);
});

test("an approval is bound to the page, element and action it was given for", async () => {
	const env = setup({ runTaskStep: sendRunner });
	const tabRef = await connect(env);
	env.driver.targetInfo = POST_SUBMIT;
	const first = await start(env, tabRef);
	await finished(env, first.taskId);
	// The page moves before the follow-up runs: the approval does not carry over to the new page.
	env.driver.tabs[0]!.url = `${WEB}/other-page`;
	await env.service.refreshTabs();
	const moved = env.service.tabs().find((t) => t.url.endsWith("/other-page"))!;
	const second = await start(env, moved.tabRef, {
		continueFrom: first.taskId,
		approvePending: true,
	});
	await finished(env, second.taskId);
	expect(env.service.taskStatus(OWNER, second.taskId).state).toBe(
		"needs_input",
	);
	expect(acts(env)).toBe(0);
});

test("a value the request did not contain is approved as an input grant and its digest ties the typing to the approval", async () => {
	const typed: string[] = [];
	const runner: TaskStepRunner = async (step, { api }) => {
		const o = await api.observe(step.tabRef!);
		const value = "tanaka@example.com";
		const granted = api.approvals().find((a) => a.kind === "input_value");
		const ref = granted
			? granted.inputValueRef
			: (
					await api.grantFromRequest({
						value,
						quote: "ログイン",
						origin: WEB,
						purpose: "email",
					})
				).inputValueRef;
		try {
			await api.operate(step.tabRef!, {
				kind: "type",
				observationRef: o.observationRef,
				ref: "e2",
				element: "Email",
				inputValueRef: ref,
				purpose: "email",
				submit: true,
			});
			return {
				kind: "done",
				state: "completed",
				coreState: null,
				text: "done",
			};
		} catch (e) {
			if (e instanceof BrowserApprovalRequired)
				return {
					kind: "done",
					state: "needs_input",
					coreState: null,
					text: "送ってよいですか",
					approvals: [
						e.request,
						{ kind: "input_value", value, origin: WEB, purpose: "email" },
					],
				};
			throw e;
		}
	};
	const env = setup({ runTaskStep: runner });
	const tabRef = await connect(env);
	const act = env.driver.act.bind(env.driver);
	env.driver.act = async (a, s) => {
		if (a.kind === "type") typed.push(a.text);
		return act(a, s);
	};
	env.driver.targetInfo = {
		tag: "input",
		type: "text",
		inForm: true,
		formMethod: "post",
		submits: true,
	};
	const first = await start(env, tabRef, { request: "ログインして" });
	await finished(env, first.taskId);
	const pending = approvalRows(env);
	expect(pending.map((r) => [r.kind, r.status])).toEqual([
		["operation", "pending"],
		["input_value", "pending"],
	]);
	expect(pending[1]!.value).toBe("tanaka@example.com");
	expect(pending[1]!.summary).not.toContain("tanaka");
	expect(typed).toEqual([]);

	const second = await start(env, tabRef, {
		request: "はい、送ってください",
		continueFrom: first.taskId,
		approvePending: true,
	});
	expect(second.approved.map((a) => a.kind)).toEqual([
		"operation",
		"input_value",
	]);
	await finished(env, second.taskId);
	expect(env.service.taskStatus(OWNER, second.taskId).state).toBe("completed");
	expect(typed).toEqual(["tanaka@example.com"]);
	// The input value left the approval row; the grant it became is erased when the task ended.
	const after = approvalRows(env);
	expect(after.every((r) => r.value === null)).toBe(true);
	const grants = env.store.read((db) =>
		db.query("SELECT provenance, value FROM browser_input_grants").all(),
	);
	expect(grants).toContainEqual({ provenance: "user_approved", value: null });
});

test("an approval for another typed value does not match", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, "検索欄に abc と入力して");
	const abc = await env.service.grantFromRequest(OWNER, taskId, {
		value: "abc",
		quote: "abc",
		origin: WEB,
		purpose: "search",
	});
	env.driver.targetInfo = {
		tag: "input",
		type: "text",
		inForm: true,
		formMethod: "post",
		submits: true,
	};
	const submit = async (ref: string) => {
		const o = await observe(env, tabRef, taskId);
		return operate(env, tabRef, taskId, {
			kind: "type",
			observationRef: o.observationRef,
			ref: "e2",
			element: "Search box",
			inputValueRef: ref,
			purpose: "search",
			submit: true,
		});
	};
	const needed = (await submit(abc.inputValueRef).catch((e) => e)).request;
	// Hand the approval to this very task, as the follow-up path does for a new one.
	env.store.write((db) => {
		db.query(
			`INSERT INTO browser_approvals(id,owner,conversation_id,task_id,kind,tab_ref,url,action,element,value_digest,summary,status,expires_at,created_at,updated_at)
			 VALUES('a1',?,?,?,'operation',?,?,?,?,?,?,'approved',?,?,?)`,
		).run(
			OWNER,
			"main",
			taskId,
			needed.tabRef,
			needed.url,
			needed.action,
			needed.element,
			"0".repeat(64),
			"s",
			Date.now() + 60_000,
			Date.now(),
			Date.now(),
		);
	});
	await expect(submit(abc.inputValueRef)).rejects.toBeInstanceOf(
		BrowserApprovalRequired,
	);
	expect(acts(env)).toBe(0);
});
