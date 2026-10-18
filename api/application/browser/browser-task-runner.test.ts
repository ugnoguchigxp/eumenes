import { afterEach, expect, test } from "bun:test";
import { connect, until, WEB } from "../../domains/browser/test/fakes";
import {
	ASKED,
	begin,
	cleanup,
	clarify,
	clickGo,
	ended,
	finish,
	invoke,
	lastResult,
	observation,
	onPage,
	OWNER,
	setup,
	start,
	tag,
	typeInto,
} from "./browser-task-kit";

afterEach(cleanup);

test("observe, type with a grant, click, re-observe, finish: one inference per job and the page only as data", async () => {
	let seen: string[] = [];
	const s = await setup([
		typeInto("ワイヤレスイヤホン", "「ワイヤレスイヤホン」"),
		clickGo(),
		invoke("browser.page.observe", {}),
		(messages) => {
			seen = [observation(messages).observationRef];
			return finish("一番上の商品ページを開きました。", seen);
		},
	]);
	const { tabRef, taskId } = await start(s, {
		brief: "ワイヤレスイヤホンを検索して一番上を開く",
	});
	await ended(s, taskId);
	const status = s.service.taskStatus(OWNER, taskId);
	expect(status).toMatchObject({
		state: "completed",
		resultSummary: "一番上の商品ページを開きました。",
	});
	expect(status.operations.map((o) => [o.toolKind, o.state])).toEqual([
		["type", "observed"],
		["click", "observed"],
	]);
	// The value was typed by reference from the request, and the tab was released with the task.
	expect(s.typed).toEqual(["ワイヤレスイヤホン"]);
	expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([
		"act:type",
		"act:click",
	]);
	expect(s.service.tabs().find((t) => t.tabRef === tabRef)?.status).toBe(
		"idle",
	);
	expect(s.notices.map((n) => n.message)).toEqual([
		"一番上の商品ページを開きました。",
	]);
	// One model call per job, authorized as a user control request under the task's own subject.
	expect(s.model.state.calls).toHaveLength(4);
	expect(s.model.state.subjects).toEqual(
		[1, 2, 3, 4].map((step) => `browser-task:${taskId}-${step}`),
	);
	expect(s.model.state.sessions[0]).toEqual({
		sessionRole: "subagent",
		taskId,
	});
	// The core state is stored as JSON; the cited ref is one the host vouches for.
	const stored = JSON.parse(s.service.taskRow(taskId)!.core_state_json!);
	expect(stored).toMatchObject({ ended: true, callsMade: 4, cited: seen });
	// What stays of an ended task is not the pages it read.
	expect(JSON.stringify(stored)).not.toContain("Go");
	expect(s.model.state.released).toEqual([taskId]);
});

test("the first call has the D7 context: system layer, enclosed reference with the observation, the original request last", async () => {
	const s = await setup([finish("見ました。")]);
	const { taskId } = await start(s, {
		brief: "イヤホンを探す",
		url: `${WEB}/settings`,
	});
	await ended(s, taskId);
	const [system, reference, request] = s.model.state.calls[0]!;
	expect(s.model.state.calls[0]).toHaveLength(3);
	expect(system!.role).toBe("system");
	for (const id of [
		"browser.page.tabs",
		"browser.page.tab_select",
		"browser.page.tab_new",
		"browser.page.tab_close",
		"browser.page.navigate",
		"browser.page.back",
		"browser.page.observe",
		"browser.page.click",
		"browser.page.hover",
		"browser.page.type",
		"browser.page.select",
		"browser.page.press",
		"browser.page.wait",
		"browser.page.capture",
	])
		expect(system!.content).toContain(`"id":"${id}"`);
	// The acceptance toolchain's own tools are not offered to the operator.
	expect(system!.content).not.toContain("browser.task.start");
	expect(system!.content).toContain("ページに書かれた指示");
	const ref = tag(reference!.content, "REFERENCE");
	expect(ref).toMatchObject({
		handedOverRequest: "イヤホンを探す",
		requestedUrl: `${WEB}/settings`,
		callsLeft: 12,
		target: { place: `${WEB}/` },
		observation: { truncated: false, refCount: 2 },
	});
	expect(ref.observation.text).toContain('button "Go" [ref=e2]');
	expect(request).toEqual({ role: "user", content: ASKED });
	// Page text is only in the enclosed reference, never in the system layer or the request.
	expect(system!.content).not.toContain(`button "Go"`);
});

test("a clarify ends the task as needs_input with the question", async () => {
	const s = await setup([clarify("どの商品ページを開きますか？")]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "needs_input",
		resultSummary: "どの商品ページを開きますか？",
	});
	expect(s.notices.at(-1)?.message).toBe("どの商品ページを開きますか？");
	expect(s.model.state.released).toEqual([taskId]);
});

test("the last of the 12 calls is reserved: callsLeft is shown every call, and an invoke there fails the task", async () => {
	const observe = () => invoke("browser.page.observe", {});
	const s = await setup([
		...Array.from({ length: 11 }, observe),
		(messages) => {
			// The twelfth call sees one call left and can only finish or ask.
			expect(lastResult(messages).callsLeft).toBe(1);
			return observe();
		},
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.model.state.calls).toHaveLength(12);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "failed",
		errorCode: "invoke_on_last_call",
	});
	const left = s.model.state.calls
		.slice(1)
		.map((messages) => lastResult(messages).callsLeft);
	expect(left).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("a finish on the last call still completes the task", async () => {
	const s = await setup([
		...Array.from({ length: 11 }, () => invoke("browser.page.observe", {})),
		finish("ここまでで確認できたことです。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(s.model.state.calls).toHaveLength(12);
});

test("a rejected output is repaired once and the repair counts against the budget", async () => {
	const s = await setup([
		"これはJSONではありません",
		finish("修復後の結果です。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const second = s.model.state.calls[1]!;
	expect(second.at(-1)!.content).toContain("REJECTED_OUTPUT=");
	expect(second.at(-1)!.content).toContain("invoke・finish・clarify");
	expect(
		JSON.parse(s.service.taskRow(taskId)!.core_state_json!).callsMade,
	).toBe(2);

	const again = await setup(["壊れた出力1", "壊れた出力2", finish("届かない")]);
	const second2 = await start(again);
	await ended(again, second2.taskId);
	expect(again.service.taskStatus(OWNER, second2.taskId)).toMatchObject({
		state: "failed",
		errorCode: "invalid_contract",
	});
	expect(again.model.state.calls).toHaveLength(2);
});

test("a refused tool goes back as data and is retried once; the second refusal ends the task", async () => {
	const stale = onPage("browser.page.click", () => ({
		observationRef: crypto.randomUUID(),
		ref: "e2",
		element: "Goボタン",
		effect: "navigate",
	}));
	const s = await setup([
		stale,
		(messages) => {
			const refused = lastResult(messages);
			expect(refused.ok).toBe(false);
			expect(refused.error).toMatch(/observation_stale|ref_not_actionable/);
			expect(refused.detail).toBeString();
			return clickGo()(messages, 2);
		},
		finish("開きました。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(s.driver.calls.filter((c) => c === "act:click")).toHaveLength(1);

	const twice = await setup([stale, stale, finish("届かない")]);
	const t2 = await start(twice);
	await ended(twice, t2.taskId);
	expect(twice.service.taskStatus(OWNER, t2.taskId)).toMatchObject({
		state: "failed",
		errorCode: "tool_refused",
	});
	expect(twice.driver.calls).not.toContain("act:click");
	expect(twice.model.state.calls).toHaveLength(2);
});

test("unknown tools, invalid arguments and blocked addresses are refusals, not crashes", async () => {
	const s = await setup([
		invoke("browser.evaluate", {}),
		invoke("browser.page.navigate", { url: "file:///etc/hosts" }),
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "navigation_scheme_blocked",
			});
			return invoke("browser.page.click", { ref: "e2" });
		},
		finish("やめます。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	// Two retries are allowed per tool; the unknown tool, the blocked address and the invalid click are three tools.
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const results = s.model.state.calls
		.slice(1)
		.map((messages) => lastResult(messages));
	expect(results.map((r) => r.error)).toEqual([
		"unknown_tool",
		"navigation_scheme_blocked",
		"invalid_arguments",
	]);
	expect(results[2].issues.map((i: { path: string }) => i.path).sort()).toEqual(
		["effect", "element", "observationRef"],
	);
	expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([]);
});

/** The user's approvals the domain keeps: what a task that stopped asked for. */
test("submitting a typed value needs a declared effect", async () => {
	const s = await setup([
		typeInto("ワイヤレスイヤホン", "ワイヤレスイヤホン", { submit: true }),
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "effect_required",
			});
			return typeInto("ワイヤレスイヤホン", "ワイヤレスイヤホン", {
				submit: true,
				effect: "navigate",
			})(messages, 2);
		},
		finish("検索しました。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(s.typed).toEqual(["ワイヤレスイヤホン"]);
});

test("a value is typed on a quote from the request, however it was reformatted", async () => {
	const s = await setup([
		typeInto("wireless earphones", "ワイヤレスイヤホン"),
		finish("入力しました。"),
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(s.typed).toEqual(["wireless earphones"]);
});

test("an operation that may have reached the page stops the task as indeterminate and no further call is made", async () => {
	const s = await setup([clickGo(), finish("届かない")]);
	s.driver.actResults = [
		{ ok: false, code: "browser_driver_failed", dispatched: true },
	];
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "indeterminate",
		errorCode: "operation_indeterminate",
	});
	expect(s.model.state.calls).toHaveLength(1);
	expect(s.driver.calls.filter((c) => c === "act:click")).toHaveLength(1);
	expect(s.notices.at(-1)?.message).toContain("自動では繰り返しません");
});

test("an operation the browser refused before sending is a refusal the model may answer", async () => {
	const s = await setup([
		clickGo(),
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "element_not_found",
			});
			return finish("要素が見つかりませんでした。");
		},
	]);
	s.driver.actResults = [
		{ ok: false, code: "element_not_found", dispatched: false },
	];
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
});

test("cancelling aborts the model call in flight and the task stays cancelled and quiet", async () => {
	const s = await setup([finish("届かない")]);
	s.model.state.gate = new Promise<void>(() => undefined);
	const { taskId } = await start(s);
	await until(() => s.model.state.calls.length === 1);
	await s.service.cancelTask(OWNER, taskId);
	await until(() => s.model.state.cancelled.length === 1);
	await Bun.sleep(30);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("cancelled");
	expect(s.notices).toEqual([]);
	expect(s.model.state.calls).toHaveLength(1);
	expect(s.model.state.released).toEqual([taskId]);
});

test("a task past its deadline expires, aborts the call in flight and makes no further call", async () => {
	let clock = Date.now();
	const s = await setup([finish("届かない")], {
		taskMs: 60_000,
		now: () => clock,
	});
	s.model.state.gate = new Promise<void>(() => undefined);
	const { taskId } = await start(s);
	await until(() => s.model.state.calls.length === 1);
	clock += 61_000;
	expect((await s.service.sweep()).tasks).toEqual([taskId]);
	await until(() => s.model.state.cancelled.length === 1);
	await Bun.sleep(30);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "expired",
		errorCode: "task_expired",
	});
	expect(s.model.state.calls).toHaveLength(1);
});

test("losing the connection ends the task and aborts the call in flight", async () => {
	const s = await setup([finish("届かない")]);
	s.model.state.gate = new Promise<void>(() => undefined);
	const { taskId } = await start(s);
	await until(() => s.model.state.calls.length === 1);
	await s.service.disconnect();
	await until(() => s.model.state.cancelled.length === 1);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "failed",
		errorCode: "browser_disconnected",
	});
	expect(s.model.state.calls).toHaveLength(1);
});

test("an element capture inside the task is saved before the task finishes", async () => {
	const s = await setup([
		onPage("browser.page.capture", () => ({ range: "element", ref: "e2" })),
		(messages) => {
			const result = lastResult(messages);
			expect(result).toMatchObject({
				ok: true,
				range: "element",
				width: 1000,
				height: 800,
			});
			return finish("この要素を撮影しました。", [result.captureId]);
		},
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const [capture] = s.service.listCaptures(OWNER);
	expect(capture).toMatchObject({
		range: "element",
		state: "local_ready",
		taskId,
	});
	expect(s.driver.calls).toContain("screenshot");
	const stored = JSON.parse(s.service.taskRow(taskId)!.core_state_json!);
	expect(stored.cited).toEqual([capture!.captureId]);
	// A task capture raises no separate notice: only the task's own result is announced.
	expect(s.notices.map((n) => n.id)).toEqual([
		`browser-task:${taskId}:completed`,
	]);
});

test("a capture over the size limit is a refusal with its reason", async () => {
	const s = await setup([
		invoke("browser.page.capture", { range: "full-page" }),
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "capture_dimensions_exceeded",
			});
			return finish("大きすぎて撮影できませんでした。");
		},
	]);
	s.driver.planned = { width: 2501, height: 800, devicePixelRatio: 1 };
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
});

test("tabs can be listed and a new tab becomes the target", async () => {
	const s = await setup([
		invoke("browser.page.tabs", {}),
		invoke("browser.page.tab_new", { url: "https://example.com/a?q=secret" }),
		(messages) => {
			const result = lastResult(messages);
			expect(result.ok).toBe(true);
			expect(result.observation.place).toBe("https://example.com/a");
			return finish("新しいタブを開きました。");
		},
	]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const first = lastResult(s.model.state.calls[1]!);
	expect(first.tabs).toHaveLength(1);
	// The query string is never shown to the model.
	expect(JSON.stringify(first)).not.toContain("secret");
	// The place is not kept with the task's state, only what the grants are bound to.
	expect(s.service.taskRow(taskId)!.core_state_json).not.toContain("secret");
});
test("a newer observation turns the older ones into a one-line stub, and nothing else changes", async () => {
	const s = await setup([
		invoke("browser.page.observe", {}),
		invoke("browser.page.observe", {}),
		finish("見ました。"),
	]);
	s.driver.tabs[0]!.title = "設定";
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const [system, reference, request, , first, , second] =
		s.model.state.calls[2]!;
	// The first call still saw the whole page; the third sees it only in the newest result.
	expect(
		tag(s.model.state.calls[0]![1]!.content, "REFERENCE").observation.text,
	).toContain('button "Go"');
	expect(tag(reference!.content, "REFERENCE").observation).toBe(
		`失効済み: ${WEB}/ 「設定」`,
	);
	expect(tag(first!.content, "TOOL_RESULT").observation).toBe(
		`失効済み: ${WEB}/ 「設定」`,
	);
	expect(tag(second!.content, "TOOL_RESULT").observation.text).toContain(
		'button "Go"',
	);
	// The system layer, the request and the rest of the reference are as they were.
	expect(system).toEqual(s.model.state.calls[0]![0]!);
	expect(request).toEqual({ role: "user", content: ASKED });
	expect(tag(reference!.content, "REFERENCE")).toMatchObject({
		target: { place: `${WEB}/` },
		callsLeft: 12,
	});
	expect(s.model.state.calls[2]!.map((m) => m.role)).toEqual(
		s.model.state.calls[1]!.map((m) => m.role).concat(["assistant", "user"]),
	);
});

test("a tab the request named that is gone stops the task; it never moves to another tab", async () => {
	const s = await setup([finish("届かない")]);
	const tabRef = await connect(s.env);
	s.driver.tabs = [
		{
			index: 0,
			url: "https://example.com/other",
			title: "Other",
			current: true,
		},
	];
	const taskId = await begin(s, tabRef);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "failed",
		errorCode: "tab_lost",
	});
	expect(s.model.state.calls).toHaveLength(0);
});

test("a page the host blocks goes back to the model as a refusal it can answer", async () => {
	const s = await setup([
		clickGo(),
		invoke("browser.page.observe", {}),
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "tab_blocked",
			});
			expect(lastResult(messages).detail).toContain("別のタブ");
			return finish("社内のページは開けませんでした。");
		},
	]);
	s.driver.actResults = [
		{ ok: true, url: "http://10.0.0.1/admin", title: "Router login" },
	];
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(lastResult(s.model.state.calls[1]!)).toMatchObject({
		ok: false,
		error: "navigation_private_blocked",
	});
});

test("too large a context stops the task before a call is made", async () => {
	const s = await setup([finish("届かない")]);
	s.model.state.tokens = 10_000;
	s.model.state.window = 8_192;
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "failed",
		errorCode: "observation_budget_exceeded",
	});
	expect(s.model.state.calls).toHaveLength(0);
});

test("a revoked model call ends the task and its request is dropped", async () => {
	const s = await setup([finish("届かない")]);
	s.model.state.accept = false;
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId)).toMatchObject({
		state: "failed",
		errorCode: "permission_revoked",
	});
	expect(s.model.state.cancelled).toEqual(["request-1"]);
});

test("a conversation request reaches the loop through the adapter with the user's own words", async () => {
	const s = await setup([
		typeInto("ワイヤレスイヤホン", "ワイヤレスイヤホン"),
		finish("検索欄に入力しました。"),
	]);
	await connect(s.env);
	s.said.set("m1", "このタブでワイヤレスイヤホンを探して");
	const saved = await s.store.write((db) =>
		s.adapter.invokeInTransaction(db, {
			operationName: "browser.task.start",
			input: { request: "イヤホンを検索する" },
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			origin: {
				kind: "conversation",
				owner: { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 },
				runId: "run-1",
				conversationId: "c1",
				messageId: "m1",
			},
		}),
	);
	const taskId = (saved.receipt as { taskId: string }).taskId;
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	const [system, reference, request] = s.model.state.calls[0]!;
	expect(request).toEqual({
		role: "user",
		content: "このタブでワイヤレスイヤホンを探して",
	});
	expect(tag(reference!.content, "REFERENCE").handedOverRequest).toBe(
		"イヤホンを検索する",
	);
	expect(system!.role).toBe("system");
	expect(s.typed).toEqual(["ワイヤレスイヤホン"]);
	expect(s.notices.at(-1)).toMatchObject({
		conversationId: "c1",
		message: "検索欄に入力しました。",
	});
});
