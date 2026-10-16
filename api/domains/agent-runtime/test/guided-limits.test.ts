import { expect, test } from "bun:test";
import { harness } from "./route-harness";
import { explorationBudget } from "../service/exploration";
import type { Prepared } from "../../capabilities";
import type { Task } from "../contracts";

test("the final model call is reserved once on the guided quick budget", () => {
	const p = {
		package: { id: "web.quick", schemaKey: "guidedResearch" },
	} as Prepared;
	const task = { deadline: 150000, model_calls: 4 } as Task;
	expect(explorationBudget(task, p, [], 0)).toMatchObject({
		canOperate: true,
		maxSearches: 2,
		maxReads: 4,
		maxExternalCalls: 6,
	});
	expect(
		explorationBudget({ ...task, model_calls: 5 }, p, [], 0).canOperate,
	).toBe(false);
	expect(
		explorationBudget({ ...task, deadline: 60000 }, p, [], 0).canOperate,
	).toBe(false);
});

test("batch read budgets and URL scopes are enforced atomically before adoption", async () => {
	for (const foreign of [false, true]) {
		const h = await harness(Date.now, false, undefined, true);
		const urls = [1, 2, 3].map((n) => `https://same.example/${n}`);
		try {
			await h.start("batch-scope", `確認 ${urls.join(" ")}`);
			const id = h.agents
				.list("batch-scope")
				.find((t) => t.kind === "worker")!.id;
			await h.runRawModelStep(id, {
				action: "invoke",
				tool: "web.read",
				arguments: { url: urls[0] },
				readAhead: (foreign
					? ["https://foreign.example/"]
					: [...urls, urls[0]]
				).map((url) => ({ url })),
			});
			expect(h.task(id).state).toBe("queued");
			expect(h.task(id).error_code).toBe(
				foreign ? "tool_url_out_of_scope" : "invalid_tool_input",
			);
			expect(
				h.store.read((db) => h.tools.invocationsInTransaction(db, id)),
			).toHaveLength(0);
		} finally {
			await h.close();
		}
	}
});

test("retry cooldown is owned by Queue without a web-specific timer or another model call", async () => {
	let now = Date.now();
	const h = await harness(() => now, false, undefined, true);
	const url = "https://retry.example/page";
	try {
		await h.start("cooldown", `取得 ${url}`);
		const id = h.agents.list("cooldown").find((t) => t.kind === "worker")!.id;
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url },
		});
		h.results.set("op1", {
			state: "partial",
			result: {
				observedAt: new Date().toISOString(),
				hits: [],
				documents: [],
				failures: [
					{ url, code: "web_rate_limited", retryable: true, cooldownMs: 1500 },
				],
			},
		});
		await h.agents.reconcile();
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url },
		});
		expect(h.started[1]?.availableAtMs).toBe(now + 1500);
		const pending = h.tools.pending()[0]!;
		expect(h.queue.get(pending.job_id)?.availableAtMs).toBe(now + 1500);
		now += 1500;
		h.results.set("op2", h.doc("再取得で確認した本文。", url));
		await h.agents.reconcile();
		expect(h.task(id).model_calls).toBe(2);
		await h.runRawModelStep(id, {
			action: "finish",
			report: {
				completion: "complete",
				answer: "再取得で確認した本文。",
				summary: "再取得で確認した本文。",
				claims: [
					{
						text: "再取得で確認した本文。",
						status: "verified",
						evidence: ["e1"],
					},
				],
				limitations: [],
			},
		});
		expect(h.task(id).state).toBe("completed");
		expect(h.task(id).tool_calls).toBe(2);
	} finally {
		await h.close();
	}
});
