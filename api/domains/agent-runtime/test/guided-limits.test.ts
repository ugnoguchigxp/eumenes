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

test("per-host slots cap paired/hedged reads while required pending work is retained", async () => {
	let now = Date.now();
	const h = await harness(() => now, false, undefined, true);
	const urls = [1, 2, 3].map((n) => `https://same.example/${n}`);
	try {
		await h.start("host-slots", `次の資料を確認 ${urls.join(" ")}`);
		const id = h.agents.list("host-slots").find((t) => t.kind === "worker")!.id;
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1).map((url) => ({ url })),
		});
		expect(h.started).toHaveLength(2);
		now += 10000;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(2);
		h.results.set("op1", h.doc("最初の本文", urls[0]));
		await h.agents.reconcile();
		await h.runRawModelStep(id, { action: "wait" });
		expect(h.task(id).state).toBe("waiting_tool");
		now += 10000;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(3);
		expect(h.tools.pending()).toHaveLength(2);
	} finally {
		await h.close();
	}
});

test("retryable read failures wait for cooldown without another model call or an early fetch", async () => {
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
		expect(h.started).toHaveLength(1);
		now += 1499;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(1);
		now++;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(2);
		expect(h.task(id).model_calls).toBe(2);
		h.results.set("op2", h.doc("再取得で確認した本文。", url));
		await h.agents.reconcile();
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
		expect(h.agents.report(id)?.claims[0]?.evidence[0]?.quote).toContain(
			"再取得で確認した本文。",
		);
		expect(h.task(id).tool_calls).toBe(2);
	} finally {
		await h.close();
	}
});
