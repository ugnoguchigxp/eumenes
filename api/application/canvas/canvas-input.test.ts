import { expect, test } from "bun:test";
import type { ChildExecution } from "../../domains/tool-runtime";
import { canvasFixture } from "./canvas.fixture";
import { canvasRequest } from "./input";

test("複数の確認質問と回答を順序どおり渡し、最後の回答を重複しない", async () => {
	const f = canvasFixture();
	try {
		const first = await f.source("ボールを作って");
		const color = await f.source("青");
		const keys = await f.source("矢印キー");
		const source = {
			conversationId: "canvas-review",
			messageId: first,
			runId: "root",
			request: "ボールを作って",
			digest: "source",
			responses: [
				{ messageId: color, request: "青", digest: "color" },
				{ messageId: keys, request: "矢印キー", digest: "keys" },
			],
		};
		const input = f.db.read((db) =>
			canvasRequest(
				db,
				f.conversation,
				{
					kind: "task",
					owner: { rootRunId: "root", taskId: "task", cancelEpoch: 0 },
					runId: "root",
					conversationId: "canvas-review",
					messageId: first,
					execution: {
						id: "child",
						executionId: "execution",
						revision: 1,
						step: 0,
						chainRevisionId: "toolchain:canvas.app@2",
						request: "planner",
						refs: [],
						deadline: Date.now() + 60_000,
						modelCalls: 6,
						source,
						resume: {
							questionId: "q2",
							input: "矢印キー",
							answerMessageId: keys,
							previous: {
								earlier: { question: "色は？" },
								question: "操作方法は？",
							},
						},
					},
				},
				"置き換えない",
			),
		);
		expect(input.message).toBe("ボールを作って");
		expect(input.conversation).toEqual([
			{ role: "assistant", text: "色は？" },
			{ role: "user", text: "青" },
			{ role: "assistant", text: "操作方法は？" },
			{ role: "user", text: "矢印キー" },
		]);
		expect(input.sourceRefs).toHaveLength(3);
	} finally {
		await f.close();
	}
});

test("taskの回答と訂正を順にMakerへ渡し、モデルのrequest引数では置き換えない", async () => {
	const f = canvasFixture();
	try {
		const first = await f.source("操作できるボールを作って");
		const answer = await f.source("矢印キーを使って");
		const amendment = await f.source("青にして");
		const child: ChildExecution = {
			id: "child",
			executionId: "execution",
			revision: 1,
			step: 0,
			chainRevisionId: "toolchain:canvas.app@2",
			request: "planner step",
			refs: [],
			deadline: Date.now() + 60_000,
			modelCalls: 6,
			source: {
				conversationId: "canvas-review",
				messageId: first,
				runId: "root",
				request: "操作できるボールを作って",
				digest: "source",
				responses: [
					{ messageId: answer, request: "矢印キーを使って", digest: "answer" },
				],
				amendments: [
					{ messageId: amendment, request: "青にして", digest: "amendment" },
				],
			},
		};
		const job = await f.invoke(first, { request: "wrong request" }, undefined, {
			kind: "task",
			owner: { rootRunId: "root", taskId: "task", cancelEpoch: 0 },
			runId: "root",
			conversationId: "canvas-review",
			messageId: first,
			execution: child,
		});
		f.queue.start();
		await f.until(() => f.jobs.job(job.id)?.state === "completed");
		expect(f.inputs[0]).toMatchObject({
			request: "操作できるボールを作って",
			conversation: [
				{ role: "user", text: "矢印キーを使って" },
				{ role: "user", text: "青にして" },
			],
		});
	} finally {
		await f.close();
	}
});

test("通常commandのホストが注入した依頼と確認回答を欠落なく渡す", async () => {
	const f = canvasFixture();
	try {
		const id = await f.source("青でお願いします");
		const request =
			'操作できるボールを作って\n\n{"previousQuestions":[{"question":"色は？","answer":{"text":"青でお願いします"}}]}';
		const job = await f.invoke(id, { request });
		f.queue.start();
		await f.until(() => f.jobs.job(job.id)?.state === "completed");
		expect(f.inputs[0]).toMatchObject({ request });
	} finally {
		await f.close();
	}
});

test("日本語を含むpayloadのバイト上限を超える依頼は、切り捨てず受付前に拒否する", async () => {
	const f = canvasFixture();
	try {
		const first = await f.source("あ".repeat(4000));
		const answer = await f.source("い".repeat(4000));
		const child = {
			id: "child",
			executionId: "execution",
			revision: 1,
			step: 0,
			chainRevisionId: "toolchain:canvas.app@2",
			request: "request",
			refs: [],
			deadline: Date.now() + 60_000,
			modelCalls: 6,
			source: {
				conversationId: "canvas-review",
				messageId: first,
				runId: "root",
				request: "あ".repeat(4000),
				digest: "source",
				responses: [
					{ messageId: answer, request: "い".repeat(4000), digest: "answer" },
				],
			},
		};
		await expect(
			f.invoke(first, {}, undefined, {
				kind: "task",
				owner: { rootRunId: "root", taskId: "task", cancelEpoch: 0 },
				runId: "root",
				conversationId: "canvas-review",
				messageId: first,
				execution: child,
			}),
		).rejects.toThrow("canvas_input_capacity");
		expect(f.jobs.latest("canvas-review")).toBeNull();
	} finally {
		await f.close();
	}
});

test("別会話の参照と、撤回した原文からは制作しない", async () => {
	const f = canvasFixture();
	try {
		const foreign = await f.source(
			"request",
			undefined,
			"another-conversation",
		);
		await expect(f.invoke(foreign)).rejects.toThrow("execution_source_invalid");
		const id = await f.source("request");
		const job = await f.invoke(id);
		await f.conversation.retract({ messageId: id });
		f.queue.start();
		await f.until(
			() => !["queued", "running"].includes(f.jobs.job(job.id)!.state),
		);
		expect(f.inputs).toHaveLength(0);
		expect(f.jobs.job(job.id)?.state).not.toBe("completed");
	} finally {
		await f.close();
	}
});

test.each([0, 5, 6, 7])(
	"確認回答%s件の境界をMakerと受付で揃える",
	async (count) => {
		const f = canvasFixture();
		try {
			const first = await f.source("ボールを作って");
			const responses = [];
			for (let n = 0; n < count; n++) {
				const request = `回答${n}`;
				responses.push({
					messageId: await f.source(request),
					request,
					digest: `answer${n}`,
				});
			}
			const accepted = f.invoke(first, {}, undefined, {
				kind: "task",
				owner: { rootRunId: "root", taskId: "task", cancelEpoch: 0 },
				runId: "root",
				conversationId: "canvas-review",
				messageId: first,
				execution: {
					id: "child",
					executionId: "execution",
					revision: 1,
					step: 0,
					chainRevisionId: "toolchain:canvas.app@2",
					request: "planner",
					refs: [],
					deadline: Date.now() + 60_000,
					modelCalls: 6,
					source: {
						conversationId: "canvas-review",
						messageId: first,
						runId: "root",
						request: "ボールを作って",
						digest: "source",
						responses,
					},
				},
			});
			if (count >= 6) {
				await expect(accepted).rejects.toThrow("canvas_input_capacity");
				expect(f.jobs.latest("canvas-review")).toBeNull();
				expect(f.inputs).toHaveLength(0);
			} else {
				const job = await accepted;
				f.queue.start();
				await f.until(() => f.jobs.job(job.id)?.state === "completed");
				expect(f.inputs[0]).toMatchObject({
					conversation: responses.map(({ request }) => ({
						role: "user",
						text: request,
					})),
				});
			}
		} finally {
			await f.close();
		}
	},
);
