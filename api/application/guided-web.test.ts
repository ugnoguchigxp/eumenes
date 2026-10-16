import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";

for (const fullResearch of [false, true])
	test(`source-linked answers survive stock → weather without parent regeneration (${fullResearch ? "broad" : "quick"})`, async () => {
		let parents = 0;
		const queries: string[] = [];
		const requests: unknown[] = [];
		const stock = {
			url: "https://example.org/9434",
			text: "ソフトバンク（9434）、2026年10月16日13:11、リアルタイム株価243.8円。",
		};
		const weather = {
			url: "https://example.org/kamakura",
			text: "鎌倉市、2026年10月16日13時の予報：晴れ、25.4℃。",
		};
		const h = await harness({
			fullResearch,
			parent: async () => {
				parents++;
				return "会話モデルで書き換えてはいけない";
			},
			control: (messages) => {
				const data = workerPacket(messages);
				expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(
					65536,
				);
				expect(data.reportMode).toBe("guided-web");
				if (!data.operations.length)
					return JSON.stringify({
						action: "invoke",
						tool: "web.lookup",
						arguments: { query: data.task.question },
						mission: {
							facts: [data.originalRequest],
							conditions: ["対象・値・日時と出典"],
						},
					});
				const page = data.observations.find((o: any) => o.basis === "page");
				if (!page)
					return JSON.stringify({
						action: "invoke",
						tool: "web.read",
						arguments: { url: data.candidates[0].url },
					});
				const text = page.excerpts.map((e: any) => e.quote).join("");
				return JSON.stringify({
					action: "finish",
					report: {
						completion: "complete",
						answer: text,
						summary: text,
						claims: [
							{
								text,
								status: "verified",
								evidence: [page.excerpts[0].reference],
							},
						],
						limitations: [],
					},
				});
			},
			acquire: async (request) => {
				requests.push(request);
				if (request.operation === "lookup") queries.push(request.query);
				const doc = (
					request.operation === "lookup"
						? request.query.includes("株価")
						: request.url === stock.url
				)
					? stock
					: weather;
				return {
					freshUntilMs: null,
					result: {
						provider: "llm-fetch@0.1.4",
						observedAt: new Date().toISOString(),
						cache: "bypass",
						failures: [],
						hits:
							request.operation === "lookup"
								? [
										{
											url: doc.url,
											title: "候補",
											snippet: "本文で確認する候補",
											provider: "fixture",
											rank: 1,
											trust: "untrusted",
											tainted: true,
											verification: "search_summary",
										},
									]
								: [],
						documents:
							request.operation === "read"
								? [
										{
											...doc,
											title: "本文",
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
					},
				};
			},
		});
		try {
			for (const [question, doc] of [
				["ソフトバンク9434の現在の株価と日時を調べて", stock],
				["今度は鎌倉の今日の天気と気温を調べて", weather],
			] as const) {
				const response = await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "switch",
					text: question,
				});
				expect(response.status).toBe(202);
				const { id } = await response.json();
				const final = await h.dialogue.waitForTerminal(id, { timeoutMs: 5000 });
				expect(final?.status).toBe("completed");
				const answer = h.dialogue.answerText(id)!;
				expect(answer).toContain(doc.text);
				expect(answer).toContain(doc.url); // host restores a missing citation from the accepted receipt
				const child = h.toolchain.agents
					.list(id)
					.find((t) => t.kind === "worker")!;
				expect(child.packageRevisionId).toBe(
					fullResearch ? "package:web.search@2" : "package:web.recipe@2",
				);
				expect(child.modelCalls).toBe(3);
			}
			expect(parents).toBe(0);
			expect(queries).toHaveLength(2);
			expect(queries[1]).toContain("鎌倉");
			expect(queries[1]).not.toContain("株価");
			expect(requests.filter((r: any) => r.operation === "read")).toMatchObject(
				[
					{ source: { query: queries[0], rank: 1, provider: "fixture" } },
					{ source: { query: queries[1], rank: 1, provider: "fixture" } },
				],
			);
		} finally {
			await h.close();
		}
	});
