import { test, expect } from "bun:test";
import { harness, forbidden } from "./toolchain.fixture";
test("the current report follows earlier failed answers and stays adjacent to the repeated request", async () => {
	const options = {
		badQuote: true,
		failureAnswer: "前回は取得できませんでした。",
	};
	const h = await harness(options);
	try {
		const question = "今日の鎌倉の天気教えて。";
		const first = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: question,
		});
		await h.dialogue.waitForTerminal(first.id, { timeoutMs: 5000 });
		expect(h.dialogue.answerText(first.id)).toBe(options.failureAnswer);
		options.badQuote = false;
		const second = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: question,
		});
		await h.dialogue.waitForTerminal(second.id, { timeoutMs: 5000 });
		const messages = JSON.parse(h.parentContexts.at(-1)!);
		const oldFailure = messages.findIndex(
			(m: { content: string }) => m.content === options.failureAnswer,
		);
		const currentReport = messages.findIndex((m: { content: string }) =>
			m.content.includes('"summary":"東京の天気は晴れ'),
		);
		expect(oldFailure).toBeGreaterThan(0);
		expect(currentReport).toBeGreaterThan(oldFailure);
		expect(currentReport).toBe(messages.length - 2);
		expect(messages.at(-1).content).toBe(question);
		expect(h.dialogue.answerText(second.id)).toContain("26度");
	} finally {
		await h.close();
	}
});
test("a premature unavailable forecast reads the next candidate before adopting an answer", async () => {
	const h = await harness({
		incompleteWeatherFirstRead: true,
		excerptEvidence: true,
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日の鎌倉の天気教えて。",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.acquisitions).toBe(3);
		expect(h.dialogue.answerText(run.id)).toContain("晴れ");
		const report = h.toolchain.agents.report(run.agentTaskId!)!;
		expect(report.summary).toContain("最高気温26度");
		expect(report.sources.every((s) => !s.url.endsWith("/empty"))).toBe(true);
		expect(
			h.workerContexts.some((c) => c.includes("weather_condition_missing")),
		).toBe(true);
	} finally {
		await h.close();
	}
});
test("authenticated search/read/report/answer resolves model excerpt selections to canonical citations", async () => {
	const h = await harness({ excerptEvidence: true });
	try {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日の鎌倉の天気をWeb検索してください。",
		});
		expect(response.status).toBe(202);
		const run = await response.json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const tasks = h.toolchain.agents.list(run.id);
		expect(tasks.every((t) => t.status === "completed" && !t.errorCode)).toBe(
			true,
		);
		const report = await (
			await h.request(`/api/agent-tasks/${run.agentTaskId}/report`)
		).json();
		expect(report.claims[0].evidence[0].quote).toContain("26度");
		expect(report.claims[0].evidence[0].excerptId).toBeUndefined();
		expect(report.verification).toBe("evidence_linked");
		expect(h.dialogue.answerText(run.id)).toContain("26度");
		expect(h.acquisitions).toBe(2);
		expect(h.parentContexts[0]).not.toContain(forbidden);
		expect(h.parentContexts[0]).not.toContain('"quote"');
	} finally {
		await h.close();
	}
});
test("unmapped location uses search and read without offering incompatible fixed forecast tools", async () => {
	const h = await harness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日の鎌倉の天気を教えて。",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const messages = JSON.parse(h.workerContexts[0]!);
		const tools = JSON.parse(
			messages[0].content.split("TOOLS=")[1].split("\nOUTPUT_SCHEMA=")[0],
		);
		expect(tools.map((tool: { id: string }) => tool.id)).toEqual([
			"web.lookup",
			"web.read",
		]);
		expect(JSON.parse(messages[1].content).nextInvocation).toBeNull();
		expect(h.acquisitions).toBe(2);
	} finally {
		await h.close();
	}
});
for (const [question, expected] of [
	["東京の天気を調べて", "26度"],
	["AAPLの株価を調べて", "250.12"],
])
	test(`authenticated API E2E: ${question}; child returns summary, never raw pages`, async () => {
		const h = await harness();
		try {
			const body = {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: question!,
			};
			const response = await h.request("/api/runs", body);
			expect(response.status).toBe(202);
			const run = await response.json();
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 5000,
			});
			expect(done?.error).toBeNull();
			expect(done?.status).toBe("completed");
			expect(h.dialogue.answerText(run.id)).toContain(expected!);
			const tasks = await (
				await h.request(`/api/agent-tasks?rootRunId=${run.id}`)
			).json();
			expect(tasks).toHaveLength(2);
			expect(
				tasks.every((t: { status: string }) => t.status === "completed"),
			).toBe(true);
			const report = await (
				await h.request(`/api/agent-tasks/${run.agentTaskId}/report`)
			).json();
			expect(report.summary).toContain(expected!);
			expect(report.verification).toBe("evidence_linked");
			expect(report.sources[0].basis).toBe("page");
			expect(h.workerContexts.some((c) => c.includes(forbidden))).toBe(true);
			expect(h.parentContexts.some((c) => c.includes(forbidden))).toBe(false);
			expect(h.parentContexts[0]).not.toContain('"quote"');
			const context = JSON.parse(JSON.parse(h.workerContexts[0]!)[1].content);
			expect(context.nextInvocation.arguments).toEqual(
				question!.includes("天気")
					? { areaCode: "130000" }
					: { symbol: "AAPL" },
			);
			expect(h.acquisitions).toBe(2);
			const duplicate = await (await h.request("/api/runs", body)).json();
			expect(duplicate.id).toBe(run.id);
			expect(h.acquisitions).toBe(2);
			expect(
				(await h.request(`/api/agent-tasks/${run.agentTaskId}`)).status,
			).toBe(200);
			expect((await h.request("/api/capabilities")).status).toBe(200);
			expect((await h.request("/api/agent-tasks")).status).toBe(400);
		} finally {
			await h.close();
		}
	});
test("1 inference slot: conversation continues while child waits; cancellation rejects late results", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await harness({ gate });
	try {
		const slow = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		for (let i = 0; i < 200 && !h.acquisitions; i++) await Bun.sleep(5);
		expect(h.acquisitions).toBe(1);
		expect(h.queue.stats().resources["inference.llm"]!.inUse).toBe(0);
		const next = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "こんにちは",
		});
		expect(
			(await h.dialogue.waitForTerminal(next.id, { timeoutMs: 3000 }))?.status,
		).toBe("completed");
		await h.dialogue.cancel(slow.id);
		release();
		await Bun.sleep(30);
		expect(h.dialogue.get(slow.id)?.status).toBe("cancelled");
		expect(h.dialogue.answerText(slow.id)).toBe(null);
		expect(
			h.toolchain.agents.list(slow.id).every((t) => t.status === "cancelled"),
		).toBe(true);
	} finally {
		release();
		await h.close();
	}
});
test("rolled-back cancellation cannot cancel another conversation's pending inference", async () => {
	let release!: () => void;
	const h = await harness({
		gate: new Promise<void>((r) => {
			release = r;
		}),
	});
	try {
		const first = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "first",
			text: "東京の天気を調べて",
		});
		const second = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "second",
			text: "AAPLの株価を調べて",
		});
		for (let i = 0; i < 200 && h.acquisitions < 2; i++) await Bun.sleep(5);
		expect(h.acquisitions).toBe(2);
		await expect(
			h.store.write((db) => {
				h.toolchain.agents.cancelTreeInTransaction(db, first.id);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await h.dialogue.cancel(second.id);
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT status FROM inference_requests WHERE subject=? AND purpose='llm'",
					)
					.get(first.id),
			),
		).toEqual({ status: "pending" });
		release();
		expect(
			(await h.dialogue.waitForTerminal(first.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(first.id)).toContain("26度");
		expect(h.dialogue.get(second.id)?.status).toBe("cancelled");
	} finally {
		release();
		await h.close();
	}
});
for (const options of [{ badJson: true }, { badQuote: true }])
	test(`bounded rejected worker output: ${JSON.stringify(options)}`, async () => {
		const h = await harness(options);
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "東京の天気を調べて",
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
			).toBe("completed");
			const child = h.toolchain.agents
				.list(run.id)
				.find((t) => t.kind === "worker")!;
			expect(child.status).toBe("failed");
			expect(h.toolchain.agents.report(run.agentTaskId!)).toBe(null);
			expect(child.modelCalls).toBeLessThanOrEqual(4);
			expect(h.parentContexts[0]).not.toContain(forbidden);
			expect(h.dialogue.answerText(run.id)).toBe(
				"調査結果を確認できませんでした。",
			);
			expect(
				h.store.read((db) =>
					db
						.query(
							"SELECT count(*) AS n FROM agent_steps WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?) AND state IN ('queued','running')",
						)
						.get(run.id),
				),
			).toEqual({ n: 0 });
		} finally {
			await h.close();
		}
	});

test("invalid tool arguments are repaired once; no acquisition occurs until the contract is valid", async () => {
	const h = await harness({ badToolArgs: true });
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("completed");
		expect(child.toolCalls).toBe(2);
		expect(child.modelCalls).toBe(4);
		expect(h.acquisitions).toBe(2);
	} finally {
		await h.close();
	}
});
test("restart interrupts the whole tree; late acquisition cannot append an answer", async () => {
	let release!: () => void;
	const h = await harness({
		gate: new Promise<void>((r) => {
			release = r;
		}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "other",
			text: "東京の天気を調べて",
		});
		for (let i = 0; i < 200 && !h.acquisitions; i++) await Bun.sleep(5);
		await h.toolchain.agents.recover();
		release();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("interrupted");
		expect(
			h.toolchain.agents.list(run.id).every((t) => t.status === "interrupted"),
		).toBe(true);
		expect(h.dialogue.answerText(run.id)).toBeNull();
	} finally {
		release();
		await h.close();
	}
});
test("data deletion invalidates the report and preserves accepted conversation", async () => {
	const h = await harness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const answer = h.dialogue.answerText(run.id);
		await h.store.write((db) =>
			h.toolchain.agents.deleteTaskDataInTransaction(db, run.id),
		);
		expect(
			(await h.request(`/api/agent-tasks/${run.agentTaskId}/report`)).status,
		).toBe(410);
		expect(h.dialogue.answerText(run.id)).toBe(answer);
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT count(*) AS n FROM tool_sources WHERE owner_task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)",
					)
					.get(run.id),
			),
		).toEqual({ n: 2 });
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT count(*) AS n FROM tool_invocations WHERE root_run_id=? AND args_json IS NOT NULL",
					)
					.get(run.id),
			),
		).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
test("retention removes 14-day result data then 30-day task metadata without deleting the answer", async () => {
	const h = await harness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const answer = h.dialogue.answerText(run.id);
		await h.store.write((db) =>
			db
				.query("UPDATE agent_tasks SET updated_at=? WHERE root_run_id=?")
				.run(Date.now() - 15 * 86400000, run.id),
		);
		await h.toolchain.agents.maintenance();
		expect(
			(await h.request(`/api/agent-tasks/${run.agentTaskId}/report`)).status,
		).toBe(410);
		expect(h.toolchain.agents.list(run.id)).toHaveLength(2);
		await h.store.write((db) =>
			db
				.query("UPDATE agent_tasks SET updated_at=? WHERE root_run_id=?")
				.run(Date.now() - 31 * 86400000, run.id),
		);
		await h.toolchain.agents.maintenance();
		expect(h.toolchain.agents.list(run.id)).toHaveLength(0);
		expect(h.dialogue.answerText(run.id)).toBe(answer);
	} finally {
		await h.close();
	}
});

test("queue capacity failure rolls back child creation and reaches a terminal answer", async () => {
	const h = await harness({
		queueLimits: { total: 1, background: 1, scope: 1 },
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const tasks = h.toolchain.agents.list(run.id);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.errorCode).toBe("queue_full");
		expect(h.acquisitions).toBe(0);
	} finally {
		await h.close();
	}
});
test("worker deadline cancels acquisition and returns a bounded failure to the parent", async () => {
	let release!: () => void;
	const h = await harness({
		gate: new Promise<void>((r) => {
			release = r;
		}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		for (let i = 0; i < 200 && !h.acquisitions; i++) await Bun.sleep(5);
		await h.store.write((db) =>
			db
				.query(
					"UPDATE agent_tasks SET deadline=? WHERE root_run_id=? AND kind='worker'",
				)
				.run(Date.now() - 1, run.id),
		);
		await h.toolchain.agents.reconcile();
		release();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("failed");
		expect(child.errorCode).toBe("deadline_exceeded");
		expect(h.parentContexts[0]).not.toContain(forbidden);
	} finally {
		release();
		await h.close();
	}
});

test("deleting a report during final inference cancels adoption of the old answer", async () => {
	let release!: () => void;
	const h = await harness({
		answerGate: new Promise<void>((r) => {
			release = r;
		}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		for (let i = 0; i < 200 && !h.parentContexts.length; i++)
			await Bun.sleep(5);
		expect(h.parentContexts).toHaveLength(1);
		await h.store.write((db) =>
			h.toolchain.agents.deleteTaskDataInTransaction(db, run.id),
		);
		release();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("cancelled");
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(
			(await h.request(`/api/agent-tasks/${run.agentTaskId}/report`)).status,
		).toBe(410);
	} finally {
		release();
		await h.close();
	}
});

test("CLI reads catalogue, task and summary through the authenticated API", async () => {
	const h = await harness();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: h.app.fetch,
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "AAPLの株価を調べて",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		for (const args of [
			["capabilities"],
			["task", run.agentTaskId!],
			["task-report", run.agentTaskId!],
			["task-cancel", run.agentTaskId!],
		]) {
			const proc = Bun.spawn(
				[process.execPath, "cli/index.ts", ...args, "--json"],
				{
					env: {
						...process.env,
						EUMENES_URL: `http://127.0.0.1:${server.port}`,
						EUMENES_API_TOKEN: "fixture-token-for-toolchain-browser",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const text = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			const value = JSON.parse(text);
			if (args[0] === "capabilities") expect(value.items).toHaveLength(3);
			else if (args[0] === "task-report")
				expect(value.summary).toContain("250.12");
			else expect(value.status).toBe("completed");
		}
	} finally {
		server.stop(true);
		await h.close();
	}
});

test("ambiguous target returns a clarification question without acquiring data or treating it as a retrieval failure", async () => {
	const h = await harness({ clarify: true });
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "天気を教えて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("どの地域の天気を調べますか？");
		expect(h.acquisitions).toBe(0);
		expect(h.toolchain.agents.list(run.id)).toHaveLength(1);
		expect(h.toolchain.agents.list(run.id)[0]!.errorCode).toBe(
			"clarification_required",
		);
		expect(h.parentContexts[0]).not.toContain('"failure":');
	} finally {
		await h.close();
	}
});

test("a mismatched quote is rejected and repaired once using the same observations", async () => {
	const h = await harness({ badQuoteOnce: true });
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "東京の天気を調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("completed");
		expect(child.modelCalls).toBe(4);
		expect(h.acquisitions).toBe(2);
		expect(h.dialogue.answerText(run.id)).toContain("26度");
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT count(*) AS n FROM inference_requests WHERE mode='control' AND status='rejected'",
					)
					.get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await h.close();
	}
});
test("a long accepted request remains intact when delegated to a research worker", async () => {
	const h = await harness();
	try {
		const question = "東京の天気を調べて。" + "補足の条件です。".repeat(400);
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "long",
			text: question,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toContain("26度");
		expect(
			JSON.parse(JSON.parse(h.workerContexts[0]!)[1].content).task.question,
		).toBe(question);
	} finally {
		await h.close();
	}
});
