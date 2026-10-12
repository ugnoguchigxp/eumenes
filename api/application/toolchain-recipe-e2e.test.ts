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
						outcome: "answered",
						summary: "晴れの予報です。",
						claims: [
							{ text: "晴れの予報", evidence: [page.excerpts[0].reference] },
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
			const saved = data.observations.find(
				(o: any) =>
					o.basis === "snippet" && String(o.title).startsWith("天気予報:"),
			);
			if (saved && offered("web.read"))
				return invoke("web.read", { url: saved.url });
			const hit = data.observations.find((o: any) => o.basis === "snippet");
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
			outcome: "answered",
			recipe: "saved",
		});
		const acquired = h.acquisitions;
		steps.length = 0;
		const second = await ask();
		// No search: the saved page is read again for current values.
		expect(steps).toEqual(["recipe.find", "web.read"]);
		expect(h.acquisitions - acquired).toBe(1);
		expect(h.toolchain.history.getSelection(second)).toMatchObject({
			outcome: "answered",
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
		// Without embeddings every available toolchain is offered.
		expect(trace.retrieval === "fts" || trace.retrieval === "none").toBe(true);
	} finally {
		await h.close();
	}
});
