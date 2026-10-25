import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";

/**
 * Host contract of the web_search toolchain with a scripted sub-agent: the model output is
 * supplied, the procedure store, URL scope, report checks and selection trace are real.
 */
test("鎌倉の天気: the second request reads the saved page again without searching", async () => {
	const steps: string[] = [];
	const h = await harness({
		control: (messages) => {
			const system = messages[0]!.content;
			if (!system.includes("TOOLS=")) return undefined;
			const data = workerPacket(messages);
			const tools = JSON.parse(
				system.split("TOOLS=")[1]!.split("\n")[0]!,
			) as Array<{
				id: string;
			}>;
			const offered = (id: string) => tools.some((t) => t.id === id);
			const invoke = (tool: string, args: unknown) => {
				steps.push(tool);
				return JSON.stringify({ action: "invoke", tool, arguments: args });
			};
			const page = data.observations.find((o: any) => o.basis === "page");
			if (page)
				return JSON.stringify({
					action: "finish",
					report: {
						completion: "complete",
						answer: "晴れの予報です。",
						summary: "晴れの予報です。",
						claims: [
							{
								text: "晴れの予報",
								status: "verified",
								evidence: [page.excerpts[0].reference],
							},
						],
						limitations: [],
						recipe: {
							signature: "天気予報: 神奈川県鎌倉市",
							url: page.url,
							readHint: "予報の本文",
						},
					},
				});
			if (!data.operations.length && offered("recipe.find"))
				return invoke("recipe.find", { query: "鎌倉市の天気予報" });
			// The sub-agent judges a saved procedure as the same request and reads it again.
			const saved = data.candidates.find((o: any) =>
				String(o.title).startsWith("天気予報:"),
			);
			if (saved && offered("web.read"))
				return invoke("web.read", { url: saved.url });
			const hit = data.candidates[0];
			if (hit && offered("web.read"))
				return invoke("web.read", { url: hit.url });
			return invoke("web.lookup", { query: "鎌倉 天気" });
		},
	});
	try {
		const ask = async () => {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "鎌倉の天気を教えて",
			});
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 8000,
			});
			expect(done?.status).toBe("completed");
			return run.id;
		};
		const first = await ask();
		expect(steps).toEqual(["recipe.find", "web.lookup", "web.read"]);
		const recipes = h.toolchain.history.listRecipes("web.search");
		expect(recipes).toHaveLength(1);
		expect(recipes[0]).toMatchObject({
			signature: "天気予報: 神奈川県鎌倉市",
			url: "https://example.com/weather",
			state: "active",
		});
		expect(h.toolchain.history.getSelection(first)).toMatchObject({
			decision: "toolchain",
			functionName: "web_search",
			toolchainId: "web.search",
			outcome: "completed",
			recipe: "saved",
		});
		const acquired = h.acquisitions;
		steps.length = 0;
		const second = await ask();
		// No search: the saved page is read again for current values.
		expect(steps).toEqual(["recipe.find", "web.read"]);
		expect(h.acquisitions - acquired).toBe(1);
		expect(h.toolchain.history.getSelection(second)).toMatchObject({
			outcome: "completed",
			recipe: "matched",
		});
		expect(h.toolchain.history.listRecipes("web.search")[0]!.successes).toBe(2);
	} finally {
		await h.close();
	}
});

test("the conversation sees one flat request function per offered toolchain", async () => {
	const h = await harness({});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "鎌倉の天気を教えて",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		const trace = h.toolchain.history.getSelection(run.id)!;
		expect(trace.candidates.map((c) => c.functionName)).toContain("web_search");
		// Discovery is bounded by explicit fixture embeddings, with no all-catalog fallback.
		expect(trace.retrieval).toBe("embedding");
		expect(trace.candidates.length).toBeLessThanOrEqual(4);
	} finally {
		await h.close();
	}
});

// Scripted protocol test only: this does not measure the model's region selection.
test.each([false, true])(
	"host permits a scripted replacement read and finish within five calls: %s",
	async (prematureFinish) => {
		const wrong = "https://example.org/yokohama";
		const correct = "https://example.org/kamakura";
		const used: string[] = [];
		let gaveUp = false;
		const h = await harness({
			control: (messages) => {
				if (!messages[0]!.content.includes("TOOLS=")) return undefined;
				const data = workerPacket(messages);
				const invoke = (tool: string, args: unknown) => {
					used.push(tool);
					return JSON.stringify({ action: "invoke", tool, arguments: args });
				};
				if (!data.operations.length)
					return invoke("recipe.find", { query: "鎌倉の天気" });
				if (prematureFinish && !gaveUp) {
					gaveUp = true;
					return JSON.stringify({
						action: "finish",
						report: {
							outcome: "not_found",
							summary: "保存手順の候補がありません。",
							claims: [],
							limitations: [],
						},
					});
				}
				if (!data.operations.some((op: any) => op.tool === "web.lookup"))
					return invoke("web.lookup", { query: "鎌倉 今日 天気" });
				const pages = data.observations.filter((o: any) => o.basis === "page");
				if (!pages.length)
					return invoke("web.read", { url: prematureFinish ? correct : wrong });
				const matched = pages.find((o: any) => o.url === correct);
				if (!matched) {
					expect(data.budget.canInvoke).toBe(true);
					return invoke("web.read", { url: correct });
				}
				expect(data.budget.canInvoke).toBe(false);
				return JSON.stringify({
					action: "finish",
					report: {
						outcome: "completed",
						summary: "鎌倉市の予報です。",
						claims: [
							{
								text: "2026年10月16日の鎌倉市は晴れ、最高25℃・最低18℃。",
								evidence: [matched.excerpts[0].reference],
							},
						],
						limitations: [],
					},
				});
			},
			acquire: async (request) => ({
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
										url: wrong,
										title: "横浜市の天気",
										snippet: "横浜市の予報です。",
										provider: "fixture",
										trust: "untrusted",
										tainted: true,
										verification: "search_summary",
									},
									{
										url: correct,
										title: "鎌倉市の天気",
										snippet: "鎌倉市の予報です。",
										provider: "fixture",
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
										url: request.url,
										title:
											request.url === correct ? "鎌倉市の天気" : "横浜市の天気",
										text:
											request.url === correct
												? "2026年10月16日の鎌倉市は晴れ、最高25℃・最低18℃。"
												: "2026年10月16日の横浜市は曇り、最高23℃。",
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
			}),
		});
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "replacement",
				text: "鎌倉の今日の天気と気温を出典付きで教えて",
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
			).toBe("completed");
			const child = h.toolchain.agents
				.list(run.id)
				.find((t) => t.kind === "worker")!;
			expect(child).toMatchObject({
				status: "completed",
				modelCalls: 5,
				toolCalls: prematureFinish ? 3 : 4,
			});
			expect(used).toEqual(
				prematureFinish
					? ["recipe.find", "web.lookup", "web.read"]
					: ["recipe.find", "web.lookup", "web.read", "web.read"],
			);
			const reported = h.reported("replacement");
			expect(reported).toContain(correct);
			expect(reported).not.toContain(wrong);
		} finally {
			await h.close();
		}
	},
);
