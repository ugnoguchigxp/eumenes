import { expect, test } from "bun:test";
import { harness } from "./route-harness";
import {
	operationLimits,
	modelLimit,
	workerDeadline,
	stepDeadline,
	explorationBudget,
} from "../service/exploration";
import type { Prepared } from "../../capabilities";
import type { Task } from "../contracts";
const prepared = {
	package: { id: "web.service-search", schemaKey: "guidedCandidates" },
} as Prepared;
test("service budgets preserve fallback and final answer without changing existing budgets", () => {
	expect(operationLimits(prepared)).toEqual({
		localCalls: 0,
		externalCalls: 3,
		searches: 1,
		reads: 1,
	});
	expect(modelLimit(prepared)).toBe(5);
	expect(workerDeadline(360000, 0, "web.service-search")).toBe(330000);
	expect(workerDeadline(180000, 0, "web.service-search")).toBe(150000);
	expect(workerDeadline(360000, 0)).toBe(150000);
	const task = { deadline: 330000, model_calls: 4 } as Task;
	expect(stepDeadline(task, 0, prepared)).toBe(30000);
	expect(stepDeadline({ ...task, deadline: 15000 }, 0, prepared)).toBe(15000);
	expect(explorationBudget(task, prepared, [], 200000).canOperate).toBe(true);
	expect(
		explorationBudget({ ...task, model_calls: 5 }, prepared, [], 200000)
			.canOperate,
	).toBe(false);
});
test("revoking the frozen package revokes a research child's caller authority", async () => {
	const h = await harness(Date.now, undefined, true, true);
	try {
		await h.store.write((db) =>
			h.agents.startInTransaction(db, {
				rootRunId: "revoked-service",
				input: {
					kind: "web",
					question: "指定サイトで検索",
					packageRevisionId: "package:web.service-search@4",
				},
				deadline: Date.now() + 360000,
			}),
		);
		const task = h.agents
			.list("revoked-service")
			.find((t) => t.kind === "worker")!;
		const owner = {
			rootRunId: "revoked-service",
			taskId: task.id,
			cancelEpoch: 0,
		};
		expect(() =>
			h.store.read((db) =>
				h.agents.authorizeReadOwnerInTransaction(db, owner, "read"),
			),
		).not.toThrow();
		await h.store.write((db) =>
			h.caps.setEnabledInTransaction(
				db,
				"package",
				"web.service-search",
				false,
			),
		);
		expect(() =>
			h.store.read((db) =>
				h.agents.authorizeReadOwnerInTransaction(db, owner, "read"),
			),
		).toThrow();
	} finally {
		await h.close();
	}
});
test("native refusal continues through external lookup and host-issued candidate result", async () => {
	const h = await harness(Date.now, undefined, true, true);
	try {
		await h.store.write((db) =>
			h.agents.startInTransaction(db, {
				rootRunId: "service-fallback",
				input: {
					kind: "web",
					question: "YouTubeでpython3の動画を探して",
					packageRevisionId: "package:web.service-search@4",
				},
				deadline: Date.now() + 360000,
			}),
		);
		const id = h.agents
			.list("service-fallback")
			.find((t) => t.kind === "worker")!.id;
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "browser.research",
			arguments: { request: "YouTubeでpython3の動画を探して" },
		});
		expect(h.started[0]?.toolId).toBe("browser.research");
		h.results.set("op1", {
			state: "failed",
			errorCode: "browser_input_required",
		});
		await h.agents.reconcile();
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.lookup",
			arguments: { query: "python3 youtube.com" },
		});
		expect(h.started[1]?.args).toEqual({
			query: "python3 youtube.com",
			language: "ja",
		});
		h.results.set("op2", {
			state: "succeeded",
			result: {
				observedAt: new Date().toISOString(),
				hits: [
					{
						url: "https://www.youtube.com/watch?v=observed",
						title: "入門動画",
						snippet: "Python3の入門",
					},
				],
				documents: [],
				failures: [],
			},
		});
		await h.agents.reconcile();
		await h.runRawModelStep(id, {
			action: "finish",
			report: {
				completion: "complete",
				answer:
					"サイト内検索は確認待ちのため外部検索で候補を見つけました。本文は未確認です。",
				summary: "動画候補",
				resultKind: "candidates",
				candidateRefs: ["c1"],
				claims: [],
				limitations: ["サイト内検索は確認待ち。本文未確認。"],
			},
		});
		expect(h.task(id).state).toBe("completed");
		const saved = h.store.read((db) =>
			db
				.query(
					"SELECT report_json,safe_projection_json FROM agent_reports WHERE task_id=?",
				)
				.get(id),
		) as { report_json: string; safe_projection_json: string };
		expect(JSON.parse(saved.report_json)).toMatchObject({
			outcome: "candidates_found",
			candidateResults: [
				{
					url: "https://www.youtube.com/watch?v=observed",
					contentStatus: "unverified",
				},
			],
		});
		expect(JSON.parse(saved.safe_projection_json).answer).toContain(
			"https://www.youtube.com/watch?v=observed",
		);
	} finally {
		await h.close();
	}
});
