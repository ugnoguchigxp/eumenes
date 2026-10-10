import { expect, test } from "bun:test";
import { harness } from "./route-harness";

test("Luna uses the common Web worker and retains the selected engine across steps", async () => {
	const h = await harness(Date.now, true);
	try {
		h.proposals.push({ kind: "unmatched" });
		await h.start("luna", "複数資料を比較して詳しく説明", "codex_luna");
		const child = h.agents.list("luna").find((t) => t.kind === "worker")!;
		expect(child.packageRevisionId).toBe("package:web.research@9");
		expect(JSON.parse(h.task(child.id).input_json!)).toMatchObject({
			researcher: "codex_luna",
		});
		await h.runModelStep(child.id, {
			action: "invoke",
			tool: "web.lookup",
			arguments: { query: "model query" },
		});
		expect(h.started[0]).toMatchObject({
			toolId: "web.lookup",
			args: { query: "model query" },
		});
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
		await h.runModelStep(child.id, {
			action: "finish",
			report: {
				outcome: "not_found",
				summary: "取得範囲には根拠がありません。",
				claims: [],
				limitations: [],
			},
		});
		expect(h.engines).toEqual(["codex_luna", "codex_luna", "codex_luna"]);
		expect(h.task(child.id).state).toBe("completed");
		await h.start("current", "語句を確認して");
		const current = h.agents.list("current").find((t) => t.kind === "worker")!;
		await h.runModelStep(current.id, {
			action: "finish",
			report: {
				outcome: "not_found",
				summary: "根拠なし",
				claims: [],
				limitations: [],
			},
		});
		expect(h.engines.at(-1)).toBeUndefined();
	} finally {
		await h.close();
	}
});

test("Luna cannot be used for history or when its provider is absent", async () => {
	const h = await harness();
	try {
		await expect(h.start("unavailable", "調査", "codex_luna")).rejects.toThrow(
			"codex_research_unavailable",
		);
	} finally {
		await h.close();
	}
	const enabled = await harness(Date.now, true);
	try {
		await expect(
			enabled.store.write((db) =>
				enabled.agents.startInTransaction(db, {
					rootRunId: "history",
					input: {
						kind: "history",
						question: "以前の発言",
						researcher: "codex_luna",
					},
					deadline: Date.now() + 10000,
				}),
			),
		).rejects.toThrow("codex_research_unavailable");
	} finally {
		await enabled.close();
	}
});
