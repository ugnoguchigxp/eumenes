import { expect, test } from "bun:test";
import { harness } from "./route-harness";

test("worker syntax correction completes without consuming its one model repair", async () => {
	const h = await harness();
	try {
		await h.start("corrected-worker");
		const child = h.agents
			.list("corrected-worker")
			.find((t) => t.kind === "worker")!;
		await h.runRawModelStep(
			child.id,
			null,
			undefined,
			"{action:'finish',report:{outcome:'clarification_required',summary:'情報なし',claims:[],limitations:[],},}",
		);
		expect(h.task(child.id).state).toBe("completed");
		expect(h.task(child.id).json_repairs).toBe(0);
		expect(h.task(child.id).model_calls).toBe(1);
	} finally {
		await h.close();
	}
});
test("worker contract failure after syntax correction retries once and then stops", async () => {
	const h = await harness();
	try {
		await h.start("invalid-corrected-worker");
		const child = h.agents
			.list("invalid-corrected-worker")
			.find((t) => t.kind === "worker")!;
		const invalid = "{action:'finish',report:{summary:42,},}";
		await h.runRawModelStep(child.id, null, undefined, invalid);
		expect(h.task(child.id).json_repairs).toBe(1);
		expect(h.task(child.id).state).toBe("queued");
		await h.runRawModelStep(child.id, null, undefined, invalid);
		expect(h.task(child.id).state).toBe("failed");
		expect(h.task(child.id).json_repairs).toBe(1);
		expect(h.task(child.id).model_calls).toBe(2);
	} finally {
		await h.close();
	}
});

test("search-only reports still reject invented evidence and return the failure to the parent", async () => {
	const h = await harness();
	try {
		await h.start("invalid-search-source", "公開情報を検索");
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
	const h = await harness();
	try {
		await h.start("failed-search", "検索して");
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
test("a worker cannot give up before invoking an available tool: one repair, then failure", async () => {
	const h = await harness();
	try {
		await h.start("give-up", "最新のニュースを調べて");
		const child = h.agents.list("give-up").find((t) => t.kind === "worker")!;
		const giveUp = {
			action: "finish",
			report: {
				outcome: "failed",
				summary: "検索ツールを利用できませんでした。",
				claims: [],
				limitations: ["ツールがありません。"],
			},
		};
		await h.runRawModelStep(child.id, giveUp);
		expect(h.task(child.id).state).toBe("queued");
		expect(h.task(child.id).json_repairs).toBe(1);
		await h.runRawModelStep(child.id, giveUp);
		expect(h.task(child.id).state).toBe("failed");
		expect(h.started).toEqual([]);
	} finally {
		await h.close();
	}
});
