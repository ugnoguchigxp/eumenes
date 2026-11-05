import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { researchScript } from "../../domains/pursuit/test/model.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("conversation selects the registered research task, uses the existing guarded Web owner, and adopts its full sourced report", async () => {
	const script = researchScript(),
		request = "複数資料を比較して反証と結論を整理して";
	const h = await harness({
		pursuit: script,
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
			answer: "本文で確認した結論です。[資料](https://example.com/source)",
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
