import { expect, test } from "bun:test";
import { harness } from "./route-harness";

test("Luna uses the common Web worker and retains the selected engine across steps", async () => {
	const h = await harness(Date.now, true);
	try {
		await h.start("luna", "複数資料を比較して詳しく説明", "codex_luna");
		const child = h.agents.list("luna").find((t) => t.kind === "worker")!;
		expect(child.packageRevisionId).toBe("package:web.search@1");
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
		expect(h.engines).toEqual(["codex_luna", "codex_luna"]);
		expect(h.agents.report(child.id)?.version).toBe(2);
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

test("search-only reports still reject invented evidence and return the failure to the parent", async () => {
	const h = await harness(Date.now, true);
	try {
		await h.start("invalid-search-source", "公開情報を検索", "codex_luna");
		const child = h.agents
			.list("invalid-search-source")
			.find((t) => t.kind === "worker")!;
		const action = {
			action: "finish",
			report: {
				outcome: "answered",
				summary: "未取得の内容",
				claims: [{ text: "未取得の内容", evidence: ["e999"] }],
				limitations: [],
			},
		};
		await h.runRawModelStep(child.id, action);
		expect(h.task(child.id).json_repairs).toBe(1);
		await h.runRawModelStep(child.id, action);
		expect(h.task(child.id).state).toBe("failed");
		expect(h.task(child.id).error_code).toBe("invalid_evidence");
		const ticket = h.store.read((db) =>
			h.agents.prepareAnswerInTransaction(db, "invalid-search-source"),
		);
		expect(ticket.reportTaskId).toBeNull();
		expect(ticket.projection).not.toContain("未取得の内容");
	} finally {
		await h.close();
	}
});

test("search failures return without creating requirement contracts or drafts", async () => {
	const h = await harness(Date.now, true);
	try {
		await h.start("failed-search", "検索して", "codex_luna");
		const child = h.agents
			.list("failed-search")
			.find((t) => t.kind === "worker")!;
		await h.runRawModelStep(child.id, {
			action: "invoke",
			tool: "web.lookup",
			arguments: { query: "公開情報" },
		});
		h.results.set("op1", { state: "failed", errorCode: "web_timeout" });
		await h.agents.reconcile();
		await h.runRawModelStep(child.id, {
			action: "finish",
			report: {
				outcome: "failed",
				summary: "検索に失敗しました。",
				claims: [],
				limitations: ["検索が時間切れになりました。"],
			},
		});
		expect(h.task(child.id).model_calls).toBe(2);
		expect(h.agents.report(child.id)).toMatchObject({
			version: 2,
			outcome: "failed",
			claims: [],
		});
		for (const table of [
			"agent_requirement_contracts",
			"agent_requirement_drafts",
		])
			expect(
				h.store.read((db) =>
					db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
				),
			).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
