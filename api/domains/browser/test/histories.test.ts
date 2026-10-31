import { afterEach, expect, test } from "bun:test";
import { REDACTED_VALUE } from "../contracts/history";
import { OWNER, retarget, runCleanup, until } from "./fakes";
import {
	SITE,
	apiOf,
	begin,
	finish,
	harness,
	histories,
	operate,
	publish,
	rowOf,
	type H,
} from "./history-fixture";

afterEach(runCleanup);

const KEYWORD = "猫 癒し";
const variables = [{ name: "keyword", label: "検索語", value: KEYWORD }];

/** The first run of a procedure: a search URL, a typed variable and a click on a result. */
async function firstRun(h: H, historyId?: string) {
	const taskId = await begin(h, `${KEYWORD}の動画を再生して`);
	const { binding } = await publish(h, taskId, {
		variables,
		...(historyId ? { historyId } : {}),
		steps: [
			{
				label: `${KEYWORD}で検索する`,
				expectation: "結果が出る",
				state: "running",
			},
		],
	});
	await operate(
		h,
		taskId,
		{
			kind: "navigate",
			url: `${SITE}/results?q=${encodeURIComponent(KEYWORD)}&lang=ja`,
		},
		{
			code: `await page.goto('${SITE}/results?q=${KEYWORD}&lang=ja');`,
			binding,
		},
	);
	const grant = await h.env.service.grantFromRequest(OWNER, taskId, {
		value: KEYWORD,
		quote: KEYWORD,
		origin: SITE,
		purpose: "検索",
		variable: "keyword",
	});
	await operate(
		h,
		taskId,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: grant.inputValueRef,
			purpose: "検索",
			submit: false,
		},
		{
			code: `await page.getByRole('combobox', { name: '検索' }).fill('${KEYWORD}');`,
			binding,
		},
	);
	await operate(
		h,
		taskId,
		{ kind: "click", element: "動画リンク" },
		{
			code: `await page.getByRole('link', { name: '${KEYWORD} 10時間' }).click();`,
			binding,
		},
	);
	return { taskId, binding };
}

const detail = (h: H, id: string) => h.env.service.historyDetail(OWNER, id);

test("a completed run becomes a history without the values of that run", async () => {
	const h = await harness();
	const { taskId } = await firstRun(h);
	await finish(h, taskId, { state: "completed" });
	const [summary] = histories(h.env);
	expect(summary).toMatchObject({
		title: "検索して再生する手順",
		request: "{{keyword}}の動画を再生して",
		place: "www.example.com",
		variables: [{ name: "keyword", label: "検索語" }],
		stepCount: 1,
		revision: 1,
		runCount: 1,
		failureCount: 0,
		lastOutcome: "completed",
		hasCommit: false,
	});
	const d = detail(h, summary!.historyId);
	expect(d.steps).toEqual([
		{ label: "{{keyword}}で検索する", expectation: "結果が出る" },
	]);
	expect(d.actions).toEqual([
		{
			seq: 1,
			kind: "navigate",
			stepLabel: "{{keyword}}で検索する",
			url: `${SITE}/results?q={{keyword}}&lang=ja`,
			place: "www.example.com/results",
			code: `await page.goto(\`${SITE}/results?q=\${encodeURIComponent(vars.keyword)}&lang=ja\`);`,
		},
		{
			seq: 2,
			kind: "type",
			stepLabel: "{{keyword}}で検索する",
			element: "検索欄",
			purpose: "検索",
			variable: "keyword",
			place: "www.example.com/results",
			code: "await page.getByRole('combobox', { name: '検索' }).fill(vars.keyword);",
		},
		{
			seq: 3,
			kind: "click",
			stepLabel: "{{keyword}}で検索する",
			element: "動画リンク",
			place: "www.example.com/results",
			code: "await page.getByRole('link', { name: '{{keyword}} 10時間' }).click();",
		},
	]);
	// Nothing of the value is stored anywhere in the row, in any encoding.
	const stored = JSON.stringify(rowOf(h.env, summary!.historyId));
	expect(stored).not.toContain(KEYWORD);
	expect(stored).not.toContain(encodeURIComponent(KEYWORD));
	expect(d.source).toContain("const vars = { keyword: '' };");
});

test("the Script's title must describe the procedure: a variable value in it is refused", async () => {
	const h = await harness();
	const taskId = await begin(h, "猫の動画");
	await expect(
		publish(h, taskId, { title: `${KEYWORD}を検索する`, variables }),
	).rejects.toThrow("script_title_has_value");
	// A one-letter ASCII value does not match inside every title.
	await publish(h, taskId, {
		title: "Search and play",
		variables: [{ name: "keyword", label: "語", value: "a" }],
	});
});

test("a Script may follow only a history the owner has; stored Scripts without title still read", async () => {
	const h = await harness();
	const first = await firstRun(h);
	await finish(h, first.taskId, { state: "completed" });
	const id = histories(h.env)[0]!.historyId;
	const taskId = await begin(h, "別の依頼");
	await expect(
		publish(h, taskId, { historyId: crypto.randomUUID() }),
	).rejects.toThrow("browser_history_not_found");
	await h.env.store.write((db) =>
		db.query("UPDATE browser_histories SET owner='someone-else'").run(),
	);
	await expect(publish(h, taskId, { historyId: id })).rejects.toThrow(
		"browser_history_not_found",
	);
	// A Script stored before histories existed has no title, historyId or variables.
	await h.env.store.write((db) =>
		db.query("UPDATE browser_tasks SET script_json=? WHERE id=?").run(
			JSON.stringify({
				revision: 1,
				summary: "古い予定",
				steps: [],
				updatedAt: 1,
				history: [],
			}),
			first.taskId,
		),
	);
	expect(h.env.service.taskStatus(OWNER, first.taskId).script).toMatchObject({
		summary: "古い予定",
	});
	expect(h.env.service.taskStatus(OWNER, first.taskId).history).toBeUndefined();
});

test("§4: a run that followed a history replaces it; a deleted one is created anew", async () => {
	const h = await harness();
	const a = await firstRun(h);
	await finish(h, a.taskId, { state: "completed" });
	const id = histories(h.env)[0]!.historyId;

	const b = await firstRun(h, id);
	expect(h.env.service.taskStatus(OWNER, b.taskId).history).toEqual({
		historyId: id,
		title: "検索して再生する手順",
	});
	await finish(h, b.taskId, { state: "completed" });
	expect(histories(h.env)).toHaveLength(1);
	expect(histories(h.env)[0]).toMatchObject({
		historyId: id,
		revision: 2,
		runCount: 2,
		lastOutcome: "completed",
	});

	// The user deletes it while a run that follows it is still going.
	const c = await firstRun(h, id);
	await h.env.store.write((db) =>
		db.query("DELETE FROM browser_histories").run(),
	);
	expect(h.env.service.taskStatus(OWNER, c.taskId).history).toBeUndefined();
	await finish(h, c.taskId, { state: "completed" });
	expect(histories(h.env)).toHaveLength(1);
	expect(histories(h.env)[0]!.historyId).not.toBe(id);
	expect(histories(h.env)[0]).toMatchObject({ revision: 1, runCount: 1 });
});

test("§4: a completed run with nothing to keep, and runs that did not complete, leave no history", async () => {
	const h = await harness();
	// Completed without any recordable operation.
	const idle = await begin(h, "何もしない");
	await publish(h, idle);
	await finish(h, idle, { state: "completed" });
	expect(histories(h.env)).toHaveLength(0);
	// A failed operation is not recorded either.
	const failed = await begin(h, "失敗する");
	await publish(h, failed);
	await retarget(h.env, h.tabRef, `${SITE}/`);
	h.env.driver.actResults.push({
		ok: false,
		code: "ref_not_found",
		dispatched: false,
	});
	await expect(
		operate(h, failed, { kind: "click", element: "Go" }),
	).resolves.toMatchObject({ state: "failed" });
	await finish(h, failed, { state: "completed" });
	expect(histories(h.env)).toHaveLength(0);
	// Failed without a history, needs_input and cancelled: nothing.
	for (const how of [
		{ state: "failed" as const, errorCode: "browser_task_failed" },
		{ state: "needs_input" as const },
	]) {
		const t = await begin(h, "別の作業");
		const { binding } = await publish(h, t);
		await operate(h, t, { kind: "navigate", url: `${SITE}/` }, { binding });
		await finish(h, t, how);
	}
	const cancelled = await begin(h, "取り消す");
	await publish(h, cancelled);
	await operate(h, cancelled, { kind: "navigate", url: `${SITE}/` });
	await h.env.service.cancelTask(OWNER, cancelled);
	expect(histories(h.env)).toHaveLength(0);
});

test("§4: a failed or indeterminate run counts against the history it followed and keeps its content", async () => {
	const h = await harness();
	const a = await firstRun(h);
	await finish(h, a.taskId, { state: "completed" });
	const id = histories(h.env)[0]!.historyId;
	const before = detail(h, id);

	const failed = await begin(h, "同じ手順");
	await publish(h, failed, { historyId: id });
	await finish(h, failed, {
		state: "failed",
		errorCode: "browser_task_failed",
	});
	expect(histories(h.env)[0]).toMatchObject({
		revision: 1,
		runCount: 1,
		failureCount: 1,
		lastOutcome: "failed",
	});
	expect(detail(h, id).actions).toEqual(before.actions);

	// An operation that may have reached the page ends the task as indeterminate.
	const unsure = await begin(h, "同じ手順");
	await publish(h, unsure, { historyId: id });
	h.env.driver.actResults.push({
		ok: false,
		code: "action_timeout",
		dispatched: true,
	});
	await operate(h, unsure, { kind: "navigate", url: `${SITE}/x` });
	await until(
		() => h.env.service.taskStatus(OWNER, unsure).state === "indeterminate",
	);
	expect(histories(h.env)[0]).toMatchObject({ failureCount: 2, revision: 1 });
});

test("§4: a task continued after an approval gathers the operations of the chain (at most three)", async () => {
	const h = await harness();
	const chain: string[] = [];
	for (let i = 0; i < 4; i++) {
		const t = await begin(
			h,
			i === 0 ? "最初の依頼" : "許可します",
			chain.length ? { continueFrom: chain.at(-1)! } : {},
		);
		chain.push(t);
		const { binding } = await publish(h, t, {
			title: "三段の手順",
			steps: [{ label: `段${i}`, expectation: "進む", state: "running" }],
		});
		await operate(
			h,
			t,
			{ kind: "navigate", url: `${SITE}/step${i}` },
			{ binding, code: `await page.goto('${SITE}/step${i}');` },
		);
		await finish(h, t, { state: i === 3 ? "completed" : "needs_input" });
	}
	const [summary] = histories(h.env);
	const d = detail(h, summary!.historyId);
	// The last three tasks' operations in order; the request is the oldest of them.
	expect(d.actions.map((a) => a.url)).toEqual([
		`${SITE}/step1`,
		`${SITE}/step2`,
		`${SITE}/step3`,
	]);
	expect(d.request).toBe("許可します");
	expect(d.steps).toEqual([{ label: "段3", expectation: "進む" }]);
});

test("§5: values the user allowed are never kept; the user's own quoted words are", async () => {
	const h = await harness();
	const taskId = await begin(h, "電話は 090-1234-5678 です");
	const { binding } = await publish(h, taskId);
	await operate(
		h,
		taskId,
		{ kind: "navigate", url: `${SITE}/form` },
		{ binding },
	);
	const own = await h.env.service.grantFromRequest(OWNER, taskId, {
		value: "09012345678",
		quote: "090-1234-5678",
		origin: SITE,
		purpose: "電話",
	});
	await operate(
		h,
		taskId,
		{
			kind: "type",
			element: "電話欄",
			inputValueRef: own.inputValueRef,
			purpose: "電話",
			submit: false,
		},
		{ binding, code: "await page.getByLabel('電話').fill('09012345678');" },
	);
	const allowed = await h.env.service.grantUserApproved(OWNER, taskId, {
		value: "s3cret-pass",
		origin: SITE,
		purpose: "合言葉",
	});
	await operate(
		h,
		taskId,
		{
			kind: "type",
			element: "合言葉欄",
			inputValueRef: allowed.inputValueRef,
			purpose: "合言葉",
			submit: false,
		},
		{
			binding,
			code: "await page.getByLabel('合言葉').pressSequentially('s3cret-pass');",
		},
	);
	await finish(h, taskId, { state: "completed" });
	const d = detail(h, histories(h.env)[0]!.historyId);
	expect(d.actions[1]).toMatchObject({
		kind: "type",
		value: "09012345678",
		code: "await page.getByLabel('電話').fill('09012345678');",
	});
	expect(d.actions[1]).not.toHaveProperty("variable");
	expect(d.actions[2]).toMatchObject({
		kind: "type",
		value: REDACTED_VALUE,
		code: `await page.getByLabel('合言葉').pressSequentially('${REDACTED_VALUE}');`,
	});
	expect(JSON.stringify(rowOf(h.env, d.historyId))).not.toContain(
		"s3cret-pass",
	);
});

test("§5: select, press and wait keep their parameters with the run's values replaced", async () => {
	const h = await harness();
	const taskId = await begin(h, `${KEYWORD}を探して`);
	const { binding } = await publish(h, taskId, { variables });
	await operate(h, taskId, { kind: "navigate", url: `${SITE}/` }, { binding });
	await operate(
		h,
		taskId,
		{ kind: "select", element: "並び順", values: ["新着", KEYWORD] },
		{
			binding,
			code: "await page.getByRole('combobox').selectOption(['新着']);",
		},
	);
	await operate(h, taskId, { kind: "press", key: "Tab" }, { binding });
	await operate(
		h,
		taskId,
		{ kind: "wait", text: `${KEYWORD}の結果`, seconds: 2 },
		{ binding },
	);
	await finish(h, taskId, { state: "completed" });
	const actions = detail(h, histories(h.env)[0]!.historyId).actions;
	expect(actions.slice(1).map((a) => [a.kind, a.value])).toEqual([
		["select", "新着, {{keyword}}"],
		["press", "Tab"],
		["wait", "{{keyword}}の結果, 2秒"],
	]);
});

test("a capture is recorded after the operations of its step; a declared commit marks the history", async () => {
	const h = await harness();
	const taskId = await begin(h, "撮って確定する");
	const { binding } = await publish(h, taskId);
	await operate(
		h,
		taskId,
		{ kind: "navigate", url: `${SITE}/cart` },
		{ binding },
	);
	// The approval the user gave for the confirmed click.
	await h.env.store.write((db) =>
		db
			.query(
				`INSERT INTO browser_approvals(id,owner,conversation_id,task_id,kind,tab_ref,url,action,element,summary,status,expires_at,created_at,updated_at)
				 VALUES(?,?,?,?,'operation',?,?,'click','確定',?,'approved',?,1,1)`,
			)
			.run(
				crypto.randomUUID(),
				OWNER,
				"main",
				taskId,
				h.tabRef,
				`${SITE}/cart`,
				"確定",
				Date.now() + 600_000,
			),
	);
	await operate(
		h,
		taskId,
		{ kind: "click", element: "確定", effect: "commit" },
		{ binding },
	);
	const before = apiOf(h, taskId);
	await until(() => apiOf(h, taskId) !== before);
	const started = await apiOf(h, taskId).capture({
		tabRef: h.tabRef,
		range: "viewport",
	});
	await until(
		() =>
			apiOf(h, taskId).captureStatus(started.captureId).state === "local_ready",
	);
	await finish(h, taskId, { state: "completed" });
	const [summary] = histories(h.env);
	expect(summary!.hasCommit).toBe(true);
	const actions = detail(h, summary!.historyId).actions;
	expect(actions.map((a) => a.kind)).toEqual(["navigate", "click", "capture"]);
	expect(actions[1]).toMatchObject({ effect: "commit" });
	expect(actions[2]).toMatchObject({
		value: "viewport",
		stepLabel: "検索する",
	});
});

test("histories are kept when the tasks that made them are purged after seven days", async () => {
	const h = await harness();
	const { taskId } = await firstRun(h);
	await finish(h, taskId, { state: "completed" });
	const id = histories(h.env)[0]!.historyId;
	await h.env.store.write((db) =>
		db.query("UPDATE browser_tasks SET updated_at=1").run(),
	);
	await h.env.service.sweep();
	expect(h.env.service.taskRow(taskId)).toBeNull();
	expect(histories(h.env)).toHaveLength(1);
	expect(detail(h, id).actions).toHaveLength(3);
	expect(rowOf(h.env, id)).toMatchObject({ source_task_id: taskId });
});

// §5.1
async function secondRun(
	h: H,
	historyId: string,
	over: Record<string, unknown> = {},
) {
	const taskId = await begin(h, "おすすめの動画を再生して");
	await publish(h, taskId, {
		historyId,
		variables: [{ name: "keyword", label: "検索語", value: "犬" }],
		...over,
	});
	return taskId;
}
const ask = (h: H, taskId: string, over: Record<string, string> = {}) =>
	apiOf(h, taskId).grantFromHistoryVariable({
		variable: "keyword",
		origin: SITE,
		purpose: "検索",
		...over,
	});

async function recorded(h: H) {
	const first = await firstRun(h);
	await finish(h, first.taskId, { state: "completed" });
	return histories(h.env)[0]!.historyId;
}

test("§5.1: a variable of the followed history is typed without asking, only where the history typed it", async () => {
	const h = await harness();
	const id = await recorded(h);
	const taskId = await secondRun(h, id);
	const granted = await ask(h, taskId);
	expect(granted).not.toBeNull();
	const grant = h.env.store.read((db) =>
		db
			.query(
				"SELECT provenance,variable,value,origin,purpose FROM browser_input_grants WHERE id=?",
			)
			.get(granted!.inputValueRef),
	);
	expect(grant).toEqual({
		provenance: "history_variable",
		variable: "keyword",
		value: "犬",
		origin: SITE,
		purpose: "検索",
	});
	// The value is the Script's, and typing it records the variable, not the value.
	const typed: string[] = [];
	const act = h.env.driver.act.bind(h.env.driver);
	h.env.driver.act = async (a, s) => {
		if (a.kind === "type") typed.push(a.text);
		return act(a, s);
	};
	await operate(h, taskId, { kind: "navigate", url: `${SITE}/` });
	await operate(
		h,
		taskId,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: granted!.inputValueRef,
			purpose: "検索",
			submit: false,
		},
		{ code: "await page.getByRole('combobox', { name: '検索' }).fill('犬');" },
	);
	expect(typed).toEqual(["犬"]);
	const op = h.env.store.read((db) =>
		db
			.query(
				"SELECT detail_json FROM browser_operations WHERE task_id=? AND tool_kind='type'",
			)
			.get(taskId),
	) as { detail_json: string };
	expect(JSON.parse(op.detail_json)).toMatchObject({
		provenance: "history_variable",
		variable: "keyword",
	});
	expect(op.detail_json).not.toContain("犬");

	// Another site, another purpose, a variable the history lacks: ask as before (null here).
	expect(
		await ask(h, taskId, { origin: "https://other.example.org" }),
	).toBeNull();
	expect(await ask(h, taskId, { purpose: "ログイン" })).toBeNull();
	await expect(ask(h, taskId, { variable: "other" })).rejects.toThrow(
		"script_variable_unknown",
	);
	await publish(h, taskId, {
		historyId: id,
		variables: [{ name: "other", label: "別", value: "x1" }],
	});
	expect(await ask(h, taskId, { variable: "other" })).toBeNull();
});

test("§5.1: no history in the Script, or a history with an operation that needed approval, asks as before", async () => {
	const h = await harness();
	const id = await recorded(h);
	const plain = await begin(h, "おすすめの動画を再生して");
	await publish(h, plain, { variables });
	expect(await ask(h, plain)).toBeNull();

	await h.env.store.write((db) =>
		db.query("UPDATE browser_histories SET has_commit=1").run(),
	);
	const taskId = await secondRun(h, id);
	expect(await ask(h, taskId)).toBeNull();
});

test("an approved value for a variable stays that variable, so the next run needs no approval", async () => {
	const h = await harness();
	const a = await begin(h, "おすすめの動画を再生して");
	await publish(h, a, { variables });
	await finish(h, a, {
		state: "needs_input",
		approvals: [
			{
				kind: "input_value",
				value: KEYWORD,
				origin: SITE,
				purpose: "検索",
				variable: "keyword",
			},
		],
	});
	const b = await begin(h, "許可します", {
		continueFrom: a,
		approvePending: true,
	});
	const { binding } = await publish(h, b, { variables });
	const [item] = apiOf(h, b).approvals();
	expect(item).toMatchObject({ kind: "input_value" });
	const grant = h.env.store.read((db) =>
		db
			.query("SELECT provenance,variable FROM browser_input_grants WHERE id=?")
			.get((item as { inputValueRef: string }).inputValueRef),
	);
	expect(grant).toEqual({ provenance: "user_approved", variable: "keyword" });
	await operate(h, b, { kind: "navigate", url: `${SITE}/` }, { binding });
	await operate(
		h,
		b,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: (item as { inputValueRef: string }).inputValueRef,
			purpose: "検索",
			submit: false,
		},
		{ binding, code: `await page.getByRole('combobox').fill('${KEYWORD}');` },
	);
	await finish(h, b, { state: "completed" });
	const d = detail(h, histories(h.env)[0]!.historyId);
	expect(d.actions[1]).toMatchObject({
		variable: "keyword",
		code: "await page.getByRole('combobox').fill(vars.keyword);",
	});
	// The next run follows it and types the new value at once.
	const c = await secondRun(h, d.historyId);
	expect(await ask(h, c)).not.toBeNull();
});

test("a variable the final Script no longer declares is kept as a redacted value", async () => {
	const h = await harness();
	const t = await begin(h, `${KEYWORD}を探す`);
	const { binding } = await publish(h, t, { variables });
	await operate(h, t, { kind: "navigate", url: `${SITE}/` }, { binding });
	const grant = await h.env.service.grantFromRequest(OWNER, t, {
		value: KEYWORD,
		quote: KEYWORD,
		origin: SITE,
		purpose: "検索",
		variable: "keyword",
	});
	await operate(
		h,
		t,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: grant.inputValueRef,
			purpose: "検索",
			submit: false,
		},
		{ binding, code: `await page.getByRole('combobox').fill('${KEYWORD}');` },
	);
	await publish(h, t, { variables: [] });
	await finish(h, t, { state: "completed" });
	const d = detail(h, histories(h.env)[0]!.historyId);
	expect(d.variables).toEqual([]);
	expect(d.actions[1]).toMatchObject({
		value: REDACTED_VALUE,
		code: `await page.getByRole('combobox').fill('${REDACTED_VALUE}');`,
	});
	expect(d.actions[1]).not.toHaveProperty("variable");
});
