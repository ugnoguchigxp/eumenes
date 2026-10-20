import { afterEach, expect, test } from "bun:test";
import { connect, fakeBrave } from "../../domains/browser/test/fakes";
import {
	cleanup,
	setup,
	invoke,
	finish,
	observation,
	lastResult,
	ended,
	OWNER,
	clickGo,
} from "./browser-task-kit";

afterEach(cleanup);
const plan = {
	expectedRevision: 0,
	summary: "表示中の項目を開いて確認します。",
	steps: [
		{
			label: "項目を開く",
			expectation: "対象の表示を確認する",
			state: "running",
		},
	],
};

test("Script is committed before dispatch; observed evidence completes a step and survives the task", async () => {
	let published: {
		revision: number;
		steps: {
			stepId: string;
			label: string;
			expectation: string;
			state: string;
		}[];
	};
	const s = await setup([
		invoke("browser.page.script", plan),
		(messages) => {
			published = lastResult(messages).script;
			expect(s.driver.calls.some((c) => c.startsWith("act:"))).toBe(false);
			return clickGo()(messages, 2);
		},
		(messages) =>
			invoke("browser.page.script", {
				...plan,
				expectedRevision: published.revision,
				steps: [
					{
						...published.steps[0],
						state: "completed",
						evidenceRef: observation(messages).observationRef,
					},
				],
			}),
		finish("対象の表示を確認しました。"),
	]);
	const tabRef = await connect(s.env);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "対象の項目を開いて",
		tabRef,
		scriptRequired: true,
	});
	await ended(s, t.taskId);
	const task = s.service.taskStatus(OWNER, t.taskId);
	expect(task.state).toBe("completed");
	expect(task.script?.steps[0]?.state).toBe("completed");
	expect(task.script?.history).toHaveLength(1);
	const op = s.store.read((db) =>
		db
			.query(
				"SELECT script_revision,script_step_id FROM browser_operations WHERE task_id=?",
			)
			.get(t.taskId),
	);
	expect(op).toEqual({
		script_revision: 1,
		script_step_id: task.script!.steps[0]!.stepId,
	});
});

test("an operation without a published Script is refused before dispatch", async () => {
	const s = await setup([clickGo(), finish("実行できませんでした。")]);
	const tabRef = await connect(s.env);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "項目を開いて",
		tabRef,
		scriptRequired: true,
	});
	await ended(s, t.taskId);
	expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([]);
	expect(JSON.stringify(s.model.state.calls)).toContain("script_not_ready");
});

test("completion without an observation are refused", async () => {
	const s = await setup([
		invoke("browser.page.script", plan),
		(messages) => {
			const script = lastResult(messages).script;
			return invoke("browser.page.script", {
				...plan,
				expectedRevision: script.revision,
				steps: [{ ...script.steps[0], state: "completed" }],
			});
		},
		finish("確認できませんでした。"),
	]);
	const tabRef = await connect(s.env);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を確認して",
		tabRef,
		scriptRequired: true,
	});
	await ended(s, t.taskId);
	const calls = JSON.stringify(s.model.state.calls);
	expect(calls).toContain("script_evidence_invalid");
	expect(s.service.taskStatus(OWNER, t.taskId).script?.revision).toBe(1);
});

test("a stale Script revision cannot overwrite the published plan", async () => {
	const s = await setup([
		invoke("browser.page.script", plan),
		invoke("browser.page.script", plan),
		finish("更新できませんでした。"),
	]);
	const tabRef = await connect(s.env);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を確認して",
		tabRef,
		scriptRequired: true,
	});
	await ended(s, t.taskId);
	expect(JSON.stringify(s.model.state.calls)).toContain(
		"script_revision_conflict",
	);
	expect(s.service.taskStatus(OWNER, t.taskId).script?.revision).toBe(1);
});

test("an authorized new task publishes Script while disconnected, then connects on demand once", async () => {
	const s = await setup(
		[
			invoke("browser.page.script", plan),
			invoke("browser.page.connect", {}),
			finish("接続しました。"),
		],
		{ canAutoConnect: () => true },
	);
	await s.service.setting.save(fakeBrave(s.env.dir));
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "ブラウザにつないで",
		scriptRequired: true,
	});
	expect(s.driver.connectCount).toBe(0);
	await ended(s, t.taskId);
	expect(s.driver.connectCount).toBe(1);
	expect(s.service.taskStatus(OWNER, t.taskId).script?.revision).toBe(1);
	await s.service.disconnect();
	expect(s.driver.connectCount).toBe(1);
});
test("changing credential revision immediately prevents use of the old connection", async () => {
	let revision = 0;
	const s = await setup([finish("終了")], {
		canAutoConnect: () => true,
		credentialRevision: () => revision,
	});
	const tabRef = await connect(s.env);
	revision++;
	expect(s.service.availability().available).toBe(false);
	await expect(s.service.focusTab(OWNER, null, tabRef)).rejects.toThrow(
		"browser_disconnected",
	);
	expect(s.driver.calls.some((c) => c.startsWith("selectTab:"))).toBe(false);
});

test("Script responses carry the current revision without copying the complete UI history into inference", async () => {
	const s = await setup([
		invoke("browser.page.script", plan),
		(messages) => {
			const script = lastResult(messages).script;
			return invoke("browser.page.script", {
				...plan,
				expectedRevision: 1,
				steps: script.steps,
				change: "確認方法を具体化",
			});
		},
		(messages) => {
			expect(lastResult(messages).script.history).toBeUndefined();
			return finish("予定を更新しました。");
		},
	]);
	const tabRef = await connect(s.env);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を確認して",
		tabRef,
		scriptRequired: true,
	});
	await ended(s, t.taskId);
	expect(s.service.taskStatus(OWNER, t.taskId).state).toBe("completed");
	expect(s.service.taskStatus(OWNER, t.taskId).script?.history).toHaveLength(1);
});

test("persisted progress distinguishes thinking, operation dispatch and the terminal task", async () => {
	const s = await setup([
		() => {
			expect(s.service.taskStatus(OWNER, id).phase).toBe("thinking");
			return invoke("browser.page.script", plan);
		},
		clickGo(),
		finish("確認しました。"),
	]);
	const tabRef = await connect(s.env);
	let id = "";
	const act = s.driver.act.bind(s.driver);
	s.driver.act = async (action, signal) => {
		expect(s.service.taskStatus(OWNER, id).phase).toBe("operating");
		return act(action, signal);
	};
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を確認して",
		tabRef,
		scriptRequired: true,
	});
	id = t.taskId;
	await ended(s, id);
	expect(s.service.taskStatus(OWNER, id)).toMatchObject({
		state: "completed",
		phase: null,
	});
});
