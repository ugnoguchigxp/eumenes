import { expect, test } from "bun:test";
import { harness } from "./route-harness";
test("an operation granted with 70 seconds remains valid after the model spends 25 seconds; only the next step stops exploration", async () => {
	let now = Date.now();
	const h = await harness(() => now);
	try {
		h.proposals.push({ kind: "unmatched" });
		await h.start("time-boundary", "公開情報を調べて");
		const child = h.agents
			.list("time-boundary")
			.find((t) => t.kind === "worker")!;
		await h.store.write((db) =>
			db
				.query("UPDATE agent_tasks SET deadline=? WHERE id=?")
				.run(now + 70000, child.id),
		);
		const step = await h.runModelStep(
			child.id,
			{
				action: "invoke",
				tool: "web.lookup",
				arguments: { query: "公開情報" },
			},
			() => {
				now += 25000;
			},
		);
		expect(step.prep.status).toBe("ready");
		expect(
			JSON.parse((step.prep as any).input.messages[1].content).budget.canInvoke,
		).toBe(true);
		expect(h.started).toHaveLength(1);
		expect(h.task(child.id).state).toBe("waiting_tool");
		h.results.set("op1", {
			state: "succeeded",
			result: {
				observedAt: new Date().toISOString(),
				hits: [],
				documents: [],
				failures: [],
			},
		});
		await h.agents.reconcile();
		const final = await h.runModelStep(child.id, {
			action: "finish",
			report: {
				outcome: "not_found",
				summary: "取得範囲に根拠がありません。",
				claims: [],
				limitations: ["残り時間"],
			},
		});
		expect(final.prep.status).toBe("ready");
		const packet = JSON.parse((final.prep as any).input.messages[1].content);
		expect(packet.budget.canInvoke).toBe(false);
		expect(h.started).toHaveLength(1);
		expect(h.task(child.id).state).toBe("completed");
	} finally {
		await h.close();
	}
});
