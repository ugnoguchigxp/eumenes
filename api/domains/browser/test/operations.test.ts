import { afterEach, expect, test } from "bun:test";
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
const observe = (env: Env, tabRef: string, taskId: string | null = null) =>
	env.service.observe({ owner: OWNER, taskId, tabRef });
const operate = (
	env: Env,
	tabRef: string | undefined,
	action: unknown,
	taskId: string | null = null,
) => env.service.operate({ owner: OWNER, taskId, tabRef, action });
const acts = (env: Env) =>
	env.driver.calls.filter((c) => c.startsWith("act:")).length;

test("an observation gives refs that work once; any action on the tab invalidates them", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const o = await observe(env, tabRef);
	expect(o).toMatchObject({
		tabRef,
		truncated: false,
		refCount: 2,
		url: `${WEB}/`,
	});
	expect(o.text).toContain("[ref=e2]");
	const click = {
		kind: "click",
		observationRef: o.observationRef,
		ref: "e2",
		element: "Go",
	};
	expect(await operate(env, tabRef, click)).toMatchObject({
		state: "observed",
	});
	await expect(operate(env, tabRef, click)).rejects.toThrow(
		"observation_stale",
	);
	expect(acts(env)).toBe(1);
	const again = await observe(env, tabRef);
	expect(again.generation).toBe(o.generation + 1);
	await expect(operate(env, tabRef, click)).rejects.toThrow(
		"observation_stale",
	);
	expect(
		await operate(env, tabRef, {
			...click,
			observationRef: again.observationRef,
		}),
	).toMatchObject({ state: "observed" });
});

test("a newer observation replaces the older one, and a ref of another tab's observation is refused", async () => {
	const env = setup();
	const a = await connect(env);
	const b = (await env.service.openTab(OWNER, null, "https://example.com/b"))
		.tabRef!;
	const first = await observe(env, a);
	const second = await observe(env, a);
	const click = (observationRef: string) => ({
		kind: "hover",
		observationRef,
		ref: "e2",
		element: "Go",
	});
	await expect(operate(env, a, click(first.observationRef))).rejects.toThrow(
		"observation_stale",
	);
	await expect(operate(env, b, click(second.observationRef))).rejects.toThrow(
		"observation_stale",
	);
	expect(await operate(env, a, click(second.observationRef))).toMatchObject({
		state: "observed",
	});
});

test("only refs inside the cut text are actionable", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.snapshotText = Array.from(
		{ length: 300 },
		(_, i) => `- link "l${i}" [ref=e${i}]`,
	).join("\n");
	const o = await observe(env, tabRef);
	expect(o).toMatchObject({ truncated: true, refCount: 200 });
	expect(o.reasons).toContain("refs");
	const act = (ref: string) => ({
		kind: "click",
		observationRef: o.observationRef,
		ref,
		element: "x",
	});
	await expect(operate(env, tabRef, act("e250"))).rejects.toThrow(
		"ref_not_actionable",
	);
	await expect(operate(env, tabRef, act("e999"))).rejects.toThrow(
		"ref_not_actionable",
	);
	expect(await operate(env, tabRef, act("e199"))).toMatchObject({
		state: "observed",
	});
});

test("navigation targets are checked before anything reaches the browser", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.calls.length = 0;
	for (const [url, code] of [
		["file:///etc/passwd", "navigation_scheme_blocked"],
		["javascript:alert(1)", "navigation_scheme_blocked"],
		["http://192.168.0.1/", "navigation_private_blocked"],
		[`${WEB}/api/settings`, "navigation_api_blocked"],
	] as const) {
		await expect(
			operate(env, tabRef, { kind: "navigate", url }),
		).rejects.toThrow(code);
		await expect(
			operate(env, undefined, { kind: "tab_new", url }),
		).rejects.toThrow(code);
	}
	expect(env.driver.calls).toEqual([]);
	expect(
		await operate(env, tabRef, { kind: "navigate", url: `${WEB}/documents` }),
	).toMatchObject({
		state: "observed",
		url: `${WEB}/documents`,
	});
});

test("an unknown or malformed operation is refused", async () => {
	const env = setup();
	const tabRef = await connect(env);
	for (const action of [
		{ kind: "evaluate", script: "1" },
		{ kind: "click" },
		{ kind: "wait" },
		{ kind: "press", key: "a b" },
	])
		await expect(operate(env, tabRef, action)).rejects.toThrow(
			"invalid_operation",
		);
});

test("an operation that may have reached the page is indeterminate, stops its task and is never repeated", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(
		env,
		tabRef,
		"press the button",
		"conversation",
	);
	env.driver.actResults.push({
		ok: false,
		code: "action_timeout",
		dispatched: true,
	});
	const out = await operate(
		env,
		tabRef,
		{ kind: "press", key: "Enter" },
		taskId,
	);
	expect(out).toMatchObject({
		state: "indeterminate",
		errorCode: "action_timeout",
	});
	const status = env.service.taskStatus(OWNER, taskId);
	expect(status).toMatchObject({
		state: "indeterminate",
		errorCode: "operation_indeterminate",
	});
	expect(status.operations).toMatchObject([
		{ toolKind: "press", state: "indeterminate" },
	]);
	await expect(
		operate(env, tabRef, { kind: "press", key: "Enter" }, taskId),
	).rejects.toThrow("task_indeterminate");
	expect(acts(env)).toBe(1);
	expect(env.notices.map((n) => n.id)).toEqual([
		`browser-task:${taskId}:indeterminate`,
	]);
	expect(env.notices[0]!.message).toContain("自動では繰り返しません");
});

test("a driver exception after dispatch is indeterminate; a refusal before dispatch is a plain failure", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.actThrows = new Error("pipe closed");
	expect(await operate(env, tabRef, { kind: "back" })).toMatchObject({
		state: "indeterminate",
	});
	env.driver.actThrows = null;
	const o = await observe(env, tabRef);
	env.driver.actResults.push({
		ok: false,
		code: "ref_not_found",
		dispatched: false,
	});
	const failed = await operate(env, tabRef, {
		kind: "click",
		observationRef: o.observationRef,
		ref: "e2",
		element: "Go",
	});
	expect(failed).toMatchObject({ state: "failed", errorCode: "ref_not_found" });
	// Nothing reached the page: the observation is still good.
	expect(
		await operate(env, tabRef, {
			kind: "click",
			observationRef: o.observationRef,
			ref: "e2",
			element: "Go",
		}),
	).toMatchObject({ state: "observed" });
});

test("the ledger records each operation with its digest and state", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await operate(
		env,
		tabRef,
		{ kind: "navigate", url: "https://example.com/" },
		taskId,
	);
	await operate(env, tabRef, { kind: "press", key: "Tab" }, taskId);
	const rows = env.store.read((db) =>
		db
			.query(
				"SELECT tool_kind, state, input_digest, tab_ref FROM browser_operations ORDER BY created_at, rowid",
			)
			.all(),
	) as {
		tool_kind: string;
		state: string;
		input_digest: string;
		tab_ref: string;
	}[];
	expect(rows.map((r) => [r.tool_kind, r.state])).toEqual([
		["navigate", "observed"],
		["press", "observed"],
	]);
	expect(rows[0]!.input_digest).toMatch(/^[0-9a-f]{64}$/);
	expect(rows[0]!.input_digest).not.toBe(rows[1]!.input_digest);
	expect(rows.every((r) => r.tab_ref === tabRef)).toBe(true);
});

test("a cancelled task's late operation is refused before it is sent", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	let release!: () => void;
	env.driver.actGate = new Promise<void>((r) => (release = r));
	const pending = operate(env, tabRef, { kind: "back" }, taskId);
	await until(() => env.driver.calls.includes("act:back"));
	await env.service.cancelTask(OWNER, taskId);
	release();
	// The call was already out: it is recorded, not hidden, and the task stays cancelled.
	expect(await pending).toMatchObject({ state: "observed" });
	expect(env.service.taskStatus(OWNER, taskId).state).toBe("cancelled");
	await expect(operate(env, tabRef, { kind: "back" }, taskId)).rejects.toThrow(
		"task_not_active",
	);
	expect(acts(env)).toBe(1);
});

test("opening and closing tabs go through the ledger and the URL check", async () => {
	const env = setup();
	await connect(env);
	const opened = await env.service.openTab(
		OWNER,
		null,
		"https://example.com/new",
	);
	expect(opened).toMatchObject({ state: "observed" });
	expect(
		env.service.tabs().find((t) => t.tabRef === opened.tabRef),
	).toMatchObject({
		url: "https://example.com/new",
		active: true,
	});
	await env.service.closeTab(OWNER, null, opened.tabRef!);
	expect(
		env.service.tabs().find((t) => t.tabRef === opened.tabRef)!.status,
	).toBe("closed");
	expect(env.driver.tabs).toHaveLength(1);
	const kinds = env.store.read((db) =>
		(
			db
				.query(
					"SELECT tool_kind FROM browser_operations ORDER BY created_at, rowid",
				)
				.all() as { tool_kind: string }[]
		).map((r) => r.tool_kind),
	);
	expect(kinds).toEqual(["tab_new", "tab_close"]);
});

// Input grants (spec 5.3)
const request = "検索ボックスに 090-1234-5678 と入力して、example.com で調べて";
async function typing(
	env: Env,
	tabRef: string,
	taskId: string,
	ref: string,
	purpose = "search",
) {
	const o = await observe(env, tabRef, taskId);
	return operate(
		env,
		tabRef,
		{
			kind: "type",
			observationRef: o.observationRef,
			ref: "e2",
			element: "box",
			inputValueRef: ref,
			purpose,
			submit: false,
		},
		taskId,
	);
}

test("a value from the current request becomes a grant bound to origin and purpose", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, request);
	const spoken = await env.service.grantFromRequest(OWNER, taskId, {
		value: "09012345678",
		quote: "090-1234-5678",
		origin: WEB,
		purpose: "search",
	});
	const typed: string[] = [];
	const act = env.driver.act.bind(env.driver);
	env.driver.act = async (a, s) => {
		if (a.kind === "type") typed.push(a.text);
		return act(a, s);
	};
	expect(await typing(env, tabRef, taskId, spoken.inputValueRef)).toMatchObject(
		{ state: "observed" },
	);
	expect(typed).toEqual(["09012345678"]);
	// Another purpose, another site or a ref of another task do not match.
	await expect(
		typing(env, tabRef, taskId, spoken.inputValueRef, "login"),
	).rejects.toThrow("grant_mismatch");
	await expect(
		typing(env, tabRef, taskId, crypto.randomUUID()),
	).rejects.toThrow("grant_not_found");
	await env.service.operate({
		owner: OWNER,
		taskId,
		tabRef,
		action: { kind: "navigate", url: "https://example.com/" },
	});
	await expect(
		typing(env, tabRef, taskId, spoken.inputValueRef),
	).rejects.toThrow("grant_mismatch");
});

test("a reformatted value is granted on a quote from the request; a quote that is not in the request is refused", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, request);
	const grant = (value: string, quote: string) =>
		env.service.grantFromRequest(OWNER, taskId, {
			value,
			quote,
			origin: WEB,
			purpose: "search",
		});
	// The value is what the model derived from the quote: it need not be a substring of the request.
	await expect(grant("example site", "example.com で調べて")).resolves.toEqual({
		inputValueRef: expect.any(String),
	});
	// Width and case in the quote do not matter.
	await expect(grant("x", "ＥＸＡＭＰＬＥ.COM")).resolves.toBeDefined();
	// Text that came from a page is not in the request, so it has no quote to stand on.
	await expect(
		grant("secret-token-from-page", "secret-token-from-page"),
	).rejects.toThrow("grant_source_mismatch");
	await expect(grant("09012345678", "お客様番号")).rejects.toThrow(
		"grant_source_mismatch",
	);
	await expect(grant("09012345678", "  ")).rejects.toThrow(
		"grant_source_mismatch",
	);
	await expect(grant("", "090")).rejects.toThrow("grant_invalid");
});

test("a quote must be at least two characters and the value at most 4x the quote plus 32", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, request);
	const grant = (value: string, quote: string) =>
		env.service.grantFromRequest(OWNER, taskId, {
			value,
			quote,
			origin: WEB,
			purpose: "search",
		});
	// One character of the request is not a quotation, even though it occurs in it.
	await expect(grant("x", "0")).rejects.toThrow("grant_source_mismatch");
	await expect(grant("x", "調")).rejects.toThrow("grant_source_mismatch");
	await expect(grant("x", "調べ")).resolves.toBeDefined();
	// "example.com" is 11 characters: up to 4 * 11 + 32 = 76 for the value.
	await expect(grant("a".repeat(76), "example.com")).resolves.toBeDefined();
	await expect(grant("a".repeat(77), "example.com")).rejects.toThrow(
		"grant_source_mismatch",
	);
	// The length of the quote counts after normalisation (spacing and separators drop out).
	await expect(grant("a".repeat(41), "調 べ")).rejects.toThrow(
		"grant_source_mismatch",
	);
	await expect(grant("a".repeat(40), "調 べ")).resolves.toBeDefined();
});

test("a user-approved grant is the only other way, and a finished task takes its grants with it", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, request);
	const approved = await env.service.grantUserApproved(OWNER, taskId, {
		value: "something the user typed in",
		origin: WEB,
		purpose: "search",
	});
	expect(
		await typing(env, tabRef, taskId, approved.inputValueRef),
	).toMatchObject({ state: "observed" });
	const rows = env.store.read((db) =>
		db.query("SELECT provenance, used_count FROM browser_input_grants").all(),
	);
	expect(rows).toEqual([{ provenance: "user_approved", used_count: 1 }]);
	await env.service.cancelTask(OWNER, taskId);
	await expect(
		env.service.grantUserApproved(OWNER, taskId, {
			value: "x",
			origin: WEB,
			purpose: "search",
		}),
	).rejects.toThrow("task_not_active");
	const gone = env.store.read((db) =>
		db.query("SELECT revoked_at FROM browser_input_grants").get(),
	) as { revoked_at: number | null };
	expect(gone.revoked_at).not.toBeNull();
});

test("a grant expires with its time, and typing needs a task", async () => {
	let clock = Date.now();
	const env = setup({
		runTaskStep: parkedRunner,
		taskMs: 3_600_000,
		now: () => clock,
	});
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef, request);
	const g = await env.service.grantFromRequest(OWNER, taskId, {
		value: "example.com",
		quote: "example.com",
		origin: WEB,
		purpose: "search",
	});
	clock += 11 * 60_000;
	await expect(typing(env, tabRef, taskId, g.inputValueRef)).rejects.toThrow(
		"grant_expired",
	);
	clock += 60_000;
	const o = await observe(env, tabRef);
	await expect(
		operate(env, tabRef, {
			kind: "type",
			observationRef: o.observationRef,
			ref: "e2",
			element: "b",
			inputValueRef: g.inputValueRef,
			purpose: "search",
			submit: false,
		}),
	).rejects.toThrow("grant_not_found");
});

test("a late response from a revoked connection is not adopted into the operation result or tab state", async () => {
	let revision = 1;
	const env = setup({ credentialRevision: () => revision });
	const tabRef = await connect(env);
	const original = env.service.tabs().find((t) => t.tabRef === tabRef)!;
	let release!: () => void;
	env.driver.actGate = new Promise<void>((r) => (release = r));
	const pending = operate(env, tabRef, { kind: "back" });
	await until(() => env.driver.calls.includes("act:back"));
	revision++;
	env.driver.tabs[0]!.title = "revoked-driver-response";
	release();
	expect(await pending).toMatchObject({
		state: "indeterminate",
		errorCode: "browser_disconnected",
	});
	expect(env.service.tabs().find((t) => t.tabRef === tabRef)?.title).toBe(
		original.title,
	);
	const rows = env.store.read((db) =>
		db.query("SELECT result_title FROM browser_operations").all(),
	);
	expect(rows).toEqual([{ result_title: null }]);
});
