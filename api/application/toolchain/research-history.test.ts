import { test, expect } from "bun:test";
import {
	replay,
	invoke,
	finish,
	syntheticAcquisition,
} from "./research-history.fixture";
const url = "https://example.com/synthetic-long";
test("an out-of-scope model URL is rejected before fetching; a finite repair can read only the original URL", async () => {
	const keyword = "集合時刻は10時";
	const h = await replay(
		[
			() => invoke("web.read", { url: "https://example.com/invented" }),
			(_data, messages) => {
				expect(h.acquisitions).toBe(0);
				expect(
					messages.some((m) => m.content.includes("tool_url_out_of_scope")),
				).toBe(true);
				return invoke("web.read", { url });
			},
			(data) => finish(data, keyword),
		],
		{
			acquire: syntheticAcquisition({ [url]: keyword }),
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url} の集合時刻を確認して`,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(1);
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("completed");
		// Search results return directly after repair, without a grading call.
		expect(child.modelCalls).toBe(3);
		expect(child.toolCalls).toBe(1);
	} finally {
		await h.close();
	}
});
test("repeating an out-of-scope URL exhausts one repair without any external acquisition", async () => {
	const h = await replay(
		Array.from(
			{ length: 2 },
			() => () => invoke("web.read", { url: "https://example.com/invented" }),
		),
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url} の集合時刻を確認して`,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		h.assertConsumed();
		expect(h.acquisitions).toBe(0);
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("failed");
		expect(child.errorCode).toBe("tool_url_out_of_scope");
		expect(child.modelCalls).toBe(2);
		expect(child.toolCalls).toBe(0);
	} finally {
		await h.close();
	}
});
test("R4/R5: after the allowed second search, a third search is refused without any external acquisition", async () => {
	let lookups = 0;
	const a = "https://example.com/wrong",
		b = "https://example.com/right",
		keyword = "大阪の10月10日の集合は11時";
	const acquire: ReturnType<typeof syntheticAcquisition> = async (
		req,
		signal,
	) => {
		if (req.operation === "lookup") lookups++;
		return syntheticAcquisition(
			lookups === 1 ? { [a]: "東京の10月9日の集合は8時" } : { [b]: keyword },
		)(req, signal);
	};
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "集合時刻" }),
			() => invoke("web.read", { url: a }),
			() => invoke("web.lookup", { query: "大阪 10月10日 集合時刻" }),
			() => invoke("web.lookup", { query: "大阪 集合 3回目" }),
			() => invoke("web.lookup", { query: "大阪 集合 3回目" }),
		],
		{
			acquire,
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "大阪の10月10日の集合時刻を調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		// Guided budget: searches 2. The third lookup is no longer offered and the repeated request fails the worker.
		expect(lookups).toBe(2);
		expect(h.acquisitions).toBe(3);
		const worker = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(worker).toMatchObject({
			status: "failed",
			errorCode: "invalid_tool_input",
			modelCalls: 5,
			toolCalls: 3,
		});
		expect(h.reported()).not.toContain(keyword);
	} finally {
		await h.close();
	}
});
test("R6: successful normalized duplicate lookup is replayed, and finishes without another external fetch", async () => {
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "ＡＢＣ  検索" }),
			() => invoke("web.lookup", { query: "abc 検索" }),
			() => ({
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "確認範囲では見つからなかった",
					claims: [],
					limitations: ["本文未確認"],
				},
			}),
		],
		{
			acquire: syntheticAcquisition({ [url]: "資料" }),
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "ABCを検索して",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(1);
		expect(h.workerContexts.at(-1)).not.toContain("operation_repeated");
		expect(
			h.toolchain.agents.report(h.dialogue.get(run.id)!.agentTaskId!)!.outcome,
		).toBe("not_found");
	} finally {
		await h.close();
	}
});
test("H1/H8: history search/read, without Memory or Web, answers from preserved raw messages with speaker/time and no fabricated URL", async () => {
	const keyword = "集合時刻は9時";
	const h = await replay(
		[
			() => invoke("history.search", { query: "集合時刻" }),
			(d) =>
				invoke("history.read", {
					messageRef: d.observations[0]!.messageRef,
					before: 1,
					after: 1,
				}),
			(d) => finish(d, keyword),
		],
		{ history: true },
	);
	try {
		await h.conversation.append({
			id: "previous",
			conversationId: "main",
			text: keyword,
			role: "user",
			createdAt: "2026-10-05T00:00:00Z",
			runId: null,
		});
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "先週決めた集合時刻を会話履歴で確認して",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(0);
		const report = h.toolchain.agents.report(
			h.dialogue.get(run.id)!.agentTaskId!,
		)!;
		expect(report.sources[0]!.messageId).toBe("previous");
		expect(report.sources[0]!.url).toBeUndefined();
		expect(report.claims[0]!.evidence[0]!.quote).toBe("");
		expect(
			h.inputs.every((d) =>
				d.observations.every((s) => s.basis === "conversation"),
			),
		).toBe(true);
		// The run handed to the history investigation is given its research time and the parent's margin.
		const settled = h.dialogue.get(run.id)!;
		expect(
			Date.parse(settled.deadlineAt!) - Date.parse(settled.createdAt),
		).toBe(330000);
	} finally {
		await h.close();
	}
});
test("H7: one stale-history retry uses the original budget and adopts only the fresh scope", async () => {
	let h: Awaited<ReturnType<typeof replay>>;
	h = await replay(
		[
			() => invoke("history.search", { query: "集合時刻" }),
			async (d) => {
				await h.conversation.correct({
					messageId: "concurrent",
					text: "別件の更新",
				});
				return invoke("history.read", {
					messageRef: d.observations[0]!.messageRef,
				});
			},
			() => invoke("history.search", { query: "集合時刻" }),
			(d) =>
				invoke("history.read", {
					messageRef: d.observations.at(-1)!.messageRef,
				}),
			(d) =>
				finish(
					{ ...d, observations: d.observations.slice(-1) },
					"集合時刻は9時",
				),
		],
		{ history: true },
	);
	try {
		await h.conversation.append({
			id: "concurrent",
			conversationId: "main",
			role: "user",
			text: "別件",
			createdAt: "2026-10-04T00:00:00Z",
			runId: null,
		});
		await h.conversation.append({
			id: "previous",
			conversationId: "main",
			role: "user",
			text: "集合時刻は9時",
			createdAt: "2026-10-05T00:00:00Z",
			runId: null,
		});
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "集合時刻を会話履歴で確認して",
		});
		const state = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });

		expect(state?.status).toBe("completed");
		h.assertConsumed();
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.modelCalls).toBe(6);
		expect(child.toolCalls).toBe(4);
		expect(h.acquisitions).toBe(0);
		expect(
			h.workerContexts.some((c) => c.includes("history_cursor_stale")),
		).toBe(true);
	} finally {
		await h.close();
	}
});
test("AG-5: preparing sources never mutates the result, so a re-settle after rollback yields one body_unavailable", async () => {
	const { createReadPorts } = await import("./research-history-ports");
	const web = { savedBodies: { issue: () => [] } };
	const runtime = {
		usesViewEvidenceInTransaction: () => true,
		authorizeReadOwnerInTransaction: () => ({ deadline: 1 }),
	};
	const ports = createReadPorts(
		web as never,
		undefined,
		() => runtime as never,
	);
	const result = {
		hits: [],
		documents: [
			{ url, title: "t", text: "body", fetchedAt: 1, truncated: false },
		],
		failures: [] as Array<{ url: string; code: string }>,
		observedAt: 1,
	};
	const inv = {
		operation_id: "op-1",
		root_run_id: "root",
		owner_task_id: "task",
		cancel_epoch: 0,
		deadline: 2,
	};
	const settle = () =>
		ports.prepareSourcesInTransaction!(
			{} as never,
			inv as never,
			result as never,
		);
	const first = settle();
	const second = settle();
	expect(result.failures).toEqual([]);
	expect(first!.failures).toEqual([{ url, code: "body_unavailable" }]);
	expect(second!.failures).toEqual([{ url, code: "body_unavailable" }]);
});
