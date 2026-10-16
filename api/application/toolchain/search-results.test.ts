import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";

for (const topic of ["公開イベントのニュース", "製品の更新情報"])
	test(`Codex research returns linked search snippets without requirement extraction or a grading call: ${topic}`, async () => {
		const h = await harness({
			fullResearch: true,
			control: (messages) => {
				const data = workerPacket(messages);
				expect(data.requirementContract).toBeUndefined();
				expect(data.requirementProfiles).toBeUndefined();
				expect(data.draftReport).toBeUndefined();
				if (!data.observations.length)
					return JSON.stringify({
						action: "invoke",
						tool: "web.lookup",
						arguments: { query: data.task.question },
					});
				const hit = data.observations[0];
				return JSON.stringify({
					action: "finish",
					report: {
						outcome: "partial",
						summary: "公開資料では更新が告知されています。",
						claims: [
							{
								text: "更新が告知されています。",
								evidence: [hit.excerpts[0].reference],
							},
						],
						limitations: ["検索抜粋のみ確認。本文は未取得。"],
					},
				});
			},
			acquire: async () => ({
				freshUntilMs: null,
				result: {
					provider: "llm-fetch@0.1.3",
					cache: "miss",
					observedAt: new Date().toISOString(),
					hits: [
						{
							url: "https://example.org/updates",
							title: "更新のお知らせ",
							snippet: "更新が告知されています。",
							provider: "fixture",
							trust: "untrusted",
							tainted: true,
							verification: "search_summary",
						},
					],
					documents: [],
					failures: [],
				},
			}),
			parent: async (messages) => {
				const result = messages.find((m) => m.content.includes('"sources":'))!;
				const report = JSON.parse(result.content).report;
				expect(report.claims).toHaveLength(1);
				expect(report.requirements).toBeUndefined();
				expect(report.coverage).toBe("partial");
				return `${report.summary} ${report.limitations[0]} [出典](${report.sources[0].url})`;
			},
		});
		try {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "search",
				text: `${topic}を検索してください。`,
			});
			expect(response.status).toBe(202);
			const run = await response.json();
			const final = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 5000,
			});
			expect(final?.status).toBe("completed");
			const child = h.toolchain.agents
				.list(run.id)
				.find((t) => t.kind === "worker")!;
			expect(child).toMatchObject({
				status: "completed",
				modelCalls: 2,
				toolCalls: 1,
				reportState: "available",
			});
			expect(h.acquisitions).toBe(1);
			const report = h.toolchain.agents.report(child.id)!;
			expect(report).toMatchObject({
				version: 2,
				verification: "evidence_linked",
				coverage: "partial",
			});
			expect(report.claims[0]!.evidence[0]!.quote).toBe(
				"更新が告知されています。",
			);
			expect(h.dialogue.answerText(run.id)).toContain(
				"https://example.org/updates",
			);
			expect(h.dialogue.answerText(run.id)).toContain("本文は未取得");
		} finally {
			await h.close();
		}
	});
