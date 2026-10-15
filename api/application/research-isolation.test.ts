import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";

for (const currentUrl of [undefined, "https://example.com/current-source"])
	test(`research receives only the current request's URLs: ${currentUrl ?? "search"}`, async () => {
		const h = await harness();
		const oldUrl = "https://www.asahi.com/topics/previous-iran-report";
		try {
			const previous = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "最新のイラン情勢を教えて",
			});
			const previousDone = await h.dialogue.waitForTerminal(previous.id, {
				timeoutMs: 5000,
			});
			expect(previousDone?.status).toBe("completed");
			await h.conversation.correct({
				messageId: previousDone!.answerMessageId!,
				text: `以前の調査の出典です。${oldUrl}`,
			});
			const question = currentUrl
				? `このURLで今日の鎌倉の天気を調べて。${currentUrl}`
				: "今日の鎌倉の天気を教えて";
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: question,
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
			).toBe("completed");
			// Selection excludes prior assistant claims; the final answer keeps the exchange.
			expect(h.routeContexts.at(-1)).not.toContain(oldUrl);
			expect(h.parentContexts.at(-1)).toContain(oldUrl);
			expect(h.workerContexts.length).toBeGreaterThan(0);
			for (const context of h.workerContexts) {
				expect(context).not.toContain(oldUrl);
				expect(context).not.toContain("イラン");
				const data = workerPacket(JSON.parse(context));
				expect(data.originalRequest).toBe(question);
				expect(data.task.question).toBe(question);
				expect(data.task.urls ?? []).toEqual(currentUrl ? [currentUrl] : []);
			}
			const tools = JSON.parse(
				JSON.parse(h.workerContexts[0]!)[0]
					.content.split("TOOLS=")[1]
					.split("\n")[0],
			).map((tool: { id: string }) => tool.id);
			expect(tools.includes("web.read")).toBe(!!currentUrl);
			expect(h.dialogue.answerText(run.id)).toContain("26度");
		} finally {
			await h.close();
		}
	});
