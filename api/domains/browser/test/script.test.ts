import { afterEach, expect, test } from "bun:test";
import type { TaskApi } from "../service";
import { setup, connect, OWNER, until, runCleanup } from "./fakes";
afterEach(runCleanup);
test("a cancelled task cannot publish a late Script or initiate a connection", async () => {
	let api: TaskApi | undefined;
	const s = setup({
		runTaskStep: async (_input, ctx) => {
			api = ctx.api;
			return { kind: "continue", coreState: {}, delayMs: 3600000 };
		},
	});
	const tabRef = await connect(s);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を確認",
		tabRef,
		scriptRequired: true,
	});
	await until(() => !!api);
	await s.service.cancelTask(OWNER, t.taskId);
	const before = s.driver.connectCount;
	await expect(
		api!.publishScript({
			expectedRevision: 0,
			title: "表示を確認する",
			summary: "表示を確認",
			steps: [{ label: "確認", expectation: "表示される", state: "running" }],
		}),
	).rejects.toThrow("task_not_active");
	await expect(api!.connect()).rejects.toThrow("task_not_active");
	await expect(api!.progress("thinking")).rejects.toThrow("task_not_active");
	expect(s.driver.connectCount).toBe(before);
	expect(s.service.taskStatus(OWNER, t.taskId).script).toBeNull();
});

test("a new Script revision prevents adoption of a capture that is still encoding", async () => {
	let api: TaskApi | undefined;
	let initial: Awaited<ReturnType<TaskApi["publishScript"]>> | undefined;
	const s = setup({
		runTaskStep: async (input, ctx) => {
			if (input.step === 1) {
				initial = await ctx.api.publishScript({
					expectedRevision: 0,
					title: "表示を保存する",
					summary: "表示を保存",
					steps: [
						{
							label: "撮影",
							expectation: "表示画像を保存する",
							state: "running",
						},
					],
				});
				return { kind: "continue", coreState: {} };
			}
			api = ctx.api;
			return { kind: "continue", coreState: {}, delayMs: 3600000 };
		},
	});
	const tabRef = await connect(s);
	const t = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: "表示を保存して",
		tabRef,
		scriptRequired: true,
	});
	await until(() => !!api);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const encode = s.encoder.encodeWebp.bind(s.encoder);
	s.encoder.encodeWebp = async (bytes) => {
		await gate;
		return encode(bytes);
	};
	const c = await api!.capture({ tabRef, range: "viewport" });
	await until(
		() => s.service.captureStatus(OWNER, c.captureId).state === "encoding",
	);
	await api!.publishScript({
		expectedRevision: 1,
		title: "表示を保存する",
		summary: "別の確認方法に変更",
		steps: initial!.steps,
		change: "計画の変更",
	});
	release();
	await until(
		() => s.service.captureStatus(OWNER, c.captureId).state === "failed",
	);
	expect(s.service.captureStatus(OWNER, c.captureId).errorCode).toBe(
		"script_revision_conflict",
	);
	expect(s.files.temp.size + s.files.final.size).toBe(0);
	await s.service.cancelTask(OWNER, t.taskId);
});
