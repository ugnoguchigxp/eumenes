import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";

for (const topic of ["公開イベントのニュース", "製品の更新情報"])
	test(`Codex research reads the selected candidate and returns a linked report without requirement extraction or a grading call: ${topic}`, async () => {
		const h = await harness({
			fullResearch: true,
			control: (messages) => {
				const data = workerPacket(messages);
				expect(data.requirementContract).toBeUndefined();
				expect(data.requirementProfiles).toBeUndefined();
				expect(data.draftReport).toBeUndefined();
				if (!data.operations.length)
					return JSON.stringify({
						action: "invoke",
						tool: "web.lookup",
						arguments: { query: data.task.question },
					});
				const page = data.observations.find((o: any) => o.basis === "page");
				if (!page)
					return JSON.stringify({
						action: "invoke",
						tool: "web.read",
						arguments: { url: data.candidates[0].url },
					});
				return JSON.stringify({
					action: "finish",
					report: {
						completion: "incomplete",
						answer: "公開資料では更新が告知されています。",
						summary: "公開資料では更新が告知されています。",
						claims: [
							{
								text: "更新が告知されています。",
								status: "verified",
								evidence: [page.excerpts[0].reference],
							},
						],
						limitations: ["検索抜粋のみ確認で本文は未取得。"],
					},
				});
			},
			acquire: async (req: any) => ({
				freshUntilMs: null,
				result: {
					provider: "llm-fetch@0.1.4",
					cache: "miss",
					observedAt: new Date().toISOString(),
					hits:
						req.operation === "lookup"
							? [
									{
										url: "https://example.org/updates",
										title: "更新のお知らせ",
										snippet: "更新が告知されています。",
										provider: "fixture",
										rank: 1,
										trust: "untrusted",
										tainted: true,
										verification: "search_summary",
									},
								]
							: [],
					documents:
						req.operation === "read"
							? [
									{
										url: "https://example.org/updates",
										title: "本文",
										text: "更新が告知されています。",
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
			}),
			parent: async (messages) => {
				// The result phase's document carries the finished research as the TODO's result (the report).
				const document = JSON.parse(
					messages.find((m) => m.role === "user" && m.content.startsWith("{"))!
						.content,
				) as { active: Array<{ result?: Record<string, any> }> };
				const report = [...document.active]
					.reverse()
					.find((entry) => entry.result)!.result!;
				expect(report.claims).toHaveLength(1);
				expect(report.requirements).toBeUndefined();
				expect(report.coverage).toBe("partial");
				return `${report.summary}${report.limitations[0]}\n\n出典：[example.org](<${report.sources[0].url}>)`;
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
				modelCalls: 3,
				toolCalls: 2,
				reportState: "available",
			});
			expect(h.acquisitions).toBe(2);
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
