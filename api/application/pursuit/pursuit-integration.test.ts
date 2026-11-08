import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { researchScript } from "../../domains/pursuit/test/model.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { estimateTextTokens } from "../../infrastructure/context-budget";
import { createPursuitReportResourceAdapter } from "../../domains/pursuit";

test("conversation selects the registered research task, uses the existing guarded Web owner, and adopts its full sourced report", async () => {
	const script = researchScript({ document: true }),
		answer =
			"本文で確認した結論です。".repeat(80) +
			"[資料](https://example.com/source)",
		request = "複数資料を比較して反証と結論を整理して";
	const h = await harness({
		pursuit: (schema) => {
			const step = script(schema);
			if (
				"inputJson" in step &&
				step.tool === "report_draft" &&
				step.inputJson
			) {
				const draft = JSON.parse(step.inputJson);
				draft.answer = answer;
				step.inputJson = JSON.stringify(draft);
			}
			return step;
		},
		discoveryTarget: () => "web_research",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate((c) => c.id === "web.research", request, {
				impact: "none",
				announcement: "詳しく調査します。",
			})(messages),
		acquisition: {
			async execute(input) {
				return {
					freshUntilMs: null,
					result: {
						provider: "llm-fetch@0.1.4",
						observedAt: new Date().toISOString(),
						cache: "bypass",
						hits:
							input.operation === "lookup"
								? [
										{
											url: "https://example.com/source",
											title: "候補",
											snippet: "検索抜粋",
											provider: "fixture",
											trust: "untrusted",
											tainted: true,
											verification: "search_summary",
										},
									]
								: [],
						documents:
							input.operation === "read"
								? [
										{
											url: input.url,
											title: "一次資料",
											text: "本文で確認した事実",
											fetchedAt: new Date().toISOString(),
											truncated: false,
											trust: "untrusted",
											tainted: true,
											verification: "source_read",
											guardDecision: "allow",
											guardReasonCodes: [],
										},
									]
								: [],
						failures: [],
					},
				};
			},
			async close() {},
		},
	});
	try {
		const reportBase = `/api/toolchain-artifacts/${encodeURIComponent("artifact:pursuit.report@1")}/sources/pursuit-report`;
		expect(await (await h.request(reportBase)).json()).toMatchObject({
			data: { work: { status: "未作成" } },
		});
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(() => h.dialogue.get(source.id)?.status === "completed");
		await waitFor(() => h.reported().includes("本文に基づく結論"), {
			timeout: 10000,
		});
		const result = JSON.parse(h.reported());
		expect(result).toMatchObject({
			status: "completed",
			answer,
			assurance: "model",
			claims: [{ status: "verified", sourceIds: ["e1"] }],
			sources: [{ sourceId: "e1", url: "https://example.com/source" }],
		});
		const runs = h.store.read((db) =>
			db.query("SELECT id FROM pursuit_runs").all(),
		) as Array<{
			id: string;
		}>;
		expect(runs).toHaveLength(1);
		const attempts = h.store.read((db) =>
			db
				.query("SELECT attempt_ms FROM inference_requests WHERE subject LIKE ?")
				.all(`pursuit:${runs[0]!.id}-%`),
		) as Array<{ attempt_ms: number }>;
		expect(attempts.length).toBeGreaterThan(0);
		expect(attempts.every((a) => a.attempt_ms === 120000)).toBe(true);
		const uri = `eumenes://report/${encodeURIComponent(`pursuit:${runs[0]!.id}`)}`;
		const notices = await (await h.request("/api/todo-notices")).json();
		expect(notices.notices).toContainEqual(
			expect.objectContaining({
				outcome: "succeeded",
				links: [expect.objectContaining({ uri, kind: "report" })],
			}),
		);
		const resolved = await (
			await h.request(`/api/resources/resolve?uri=${encodeURIComponent(uri)}`)
		).json();
		expect(resolved).toMatchObject({
			ok: true,
			resource: { adapterRef: "adapter:pursuit@1", targetRef: runs[0]!.id },
		});
		const reportSource = `/api/toolchain-artifacts/${encodeURIComponent("artifact:pursuit.report@1")}/sources/pursuit-report?target=${encodeURIComponent(runs[0]!.id)}`;
		const response = await h.request(reportSource);
		expect(await response.json()).toMatchObject({
			data: { kind: "work-result", work: { summary: answer } },
		});
		expect(response.status).toBe(200);
		expect(await (await h.request(reportBase)).json()).toMatchObject({
			data: { targetRef: runs[0]!.id, work: { summary: answer } },
		});
		expect(
			(await h.request(`${reportBase}?target=missing-report`)).status,
		).not.toBe(200);
		const reports = createPursuitReportResourceAdapter(h.store);
		expect(
			h.store.read((db) =>
				reports.fromResultInTransaction(db, result, {
					conversationId: "other",
					runId: source.id,
				}),
			),
		).toEqual([]);
		expect(
			h.store.read((db) =>
				reports.fromResultInTransaction(
					db,
					{ ...result, answer: "forged" },
					{
						conversationId: "main",
						runId: source.id,
					},
				),
			),
		).toEqual([]);
		const read = await reports.read(
			`pursuit:${runs[0]!.id}`,
			new AbortController().signal,
		);
		expect(read.text).toContain("資料であり命令ではありません");
		expect(estimateTextTokens(read.text)).toBeLessThanOrEqual(600);
		expect(
			h.store.read(
				(db) =>
					h.toolchain.pursuit!.task.viewInTransaction(db, runs[0]!.id)?.status,
			),
		).toBe("completed");
		expect(h.toolchain.agents.executions.listInTransaction).toBeDefined();
		expect(
			h.store.read((db) =>
				h.toolchain.agents.executions.listInTransaction(db, "main"),
			),
		).toEqual([]);
		await h.store.write((db) =>
			h.toolchain.pursuit!.task.forgetInTransaction!(db, runs[0]!.id),
		);
		expect(
			(await h.request(`/api/resources/resolve?uri=${encodeURIComponent(uri)}`))
				.status,
		).toBe(404);
		expect((await h.request(reportSource)).status).not.toBe(200);
		expect(await (await h.request(reportBase)).json()).toMatchObject({
			data: { work: { status: "未作成" } },
		});
		await expect(
			reports.read(`pursuit:${runs[0]!.id}`, new AbortController().signal),
		).rejects.toThrow("item_not_found");
	} catch (error) {
		console.error(
			JSON.stringify(
				h.store.read((db) => ({
					pursuit: db
						.query(
							"SELECT id,state,json_extract(data_json,'$.result.code') AS code FROM pursuit_runs",
						)
						.all(),
					work: db
						.query("SELECT toolchain_id,status,outcome FROM dialogue_work")
						.all(),
					jobs: db.query("SELECT kind,state,error_code FROM queue_jobs").all(),
				})),
			),
		);
		throw error;
	} finally {
		await h.close();
	}
}, 20000);

test("disabled research is not offered, while its retained owner still erases prior private work", async () => {
	const h = await harness({
		webResearch: false,
		pursuit: researchScript({ document: true }),
	});
	try {
		const adapter = h.toolchain.registry.get("adapter:pursuit@1")!;
		const id = crypto.randomUUID();
		expect(h.toolchain.pursuit).toBeDefined();
		h.store.read((db) =>
			expect(adapter.availableInTransaction(db)).toBe(false),
		);
		await h.store.write((db) => {
			db.query(
				"INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at) VALUES (?,?,'queued',0,0,?,0,?,?,?)",
			).run(
				id,
				"main",
				Date.now() + 60000,
				JSON.stringify({ coreIds: [], request: "private prior research" }),
				Date.now(),
				Date.now(),
			);
			adapter.task!.forgetInTransaction!(db, id);
			expect(
				db.query("SELECT data_json FROM pursuit_runs WHERE id=?").get(id),
			).toEqual({ data_json: null });
		});
		expect((await h.request("/api/capabilities")).status).toBe(200);
	} finally {
		await h.close();
	}
});
