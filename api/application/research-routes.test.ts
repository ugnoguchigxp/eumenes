import { afterEach, expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});

test("weather, term lookup and detailed research follow the model's operations without topic routing or automatic learning", async () => {
	for (const question of [
		"天気予報 鎌倉 明日 最高気温",
		"WBSとは何か調べて",
		"DeepSeek harnessについて詳しく調べて",
	]) {
		const requests: unknown[] = [];
		const h = await harness({
			control(messages) {
				if (!messages[0]?.content.includes("TOOLS=")) return;
				const data = JSON.parse(
					messages.find((m) => m.role === "user")!.content,
				);
				const page = data.observations.find(
					(o: { basis: string }) => o.basis === "page",
				);
				if (page)
					return JSON.stringify({
						action: "finish",
						report: {
							outcome: "answered",
							summary: "調査担当が資料から選んだ報告",
							claims: [
								{
									text: "資料の対象と条件を確認した",
									evidence: [page.excerpts[0].reference],
								},
							],
							limitations: [],
						},
					});
				return JSON.stringify(
					data.observations.length
						? {
								action: "invoke",
								tool: "web.read",
								arguments: { url: "https://example.com/source" },
							}
						: {
								action: "invoke",
								tool: "web.lookup",
								arguments: {
									query: "model-selected query",
									language: "en",
									region: "GB",
								},
							},
				);
			},
			acquire: async (req) => {
				requests.push(req);
				return {
					freshUntilMs: null,
					result: {
						provider: "llm-fetch@0.1.2",
						observedAt: new Date().toISOString(),
						cache: "bypass",
						failures: [],
						hits:
							req.operation === "lookup"
								? [
										{
											url: "https://example.com/source",
											title: "Source",
											snippet: "A source",
											provider: "fixture",
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
											url: req.url,
											title: "Source",
											text: "資料の対象と条件を確認した。話題を限定しない原文の根拠。",
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
		open.push(h.close);
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: question,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(requests[0]).toMatchObject({
			operation: "lookup",
			query: "model-selected query",
			language: "en",
			region: "GB",
		});
		expect(requests).toHaveLength(2);
		expect(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) n FROM research_route_keys").get(),
			),
		).toEqual({ n: 0 });
		expect(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) n FROM research_route_drafts").get(),
			),
		).toEqual({ n: 0 });
		expect(h.parentContexts.join("\n")).toContain(
			"調査担当が資料から選んだ報告",
		);
	}
}, 15000);
