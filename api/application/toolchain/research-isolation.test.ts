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
			expect(h.workerContexts.length).toBeGreaterThan(0);
			for (const context of h.workerContexts) {
				// Nothing of an earlier answer reaches the research.
				expect(context).not.toContain(oldUrl);
				const data = workerPacket(JSON.parse(context));
				expect(data.originalRequest).toBe(question);
				// The router's hand-over carries the user's utterance before the request only as delimited context
				// after it (spec toolchain-router-redesign 2026-11-01, the request's words); its URLs are not the
				// request's.
				const [asked, ...earlier] = data.task.question.split("\n");
				expect(asked).toBe(question);
				expect(earlier.join("\n")).toStartWith("直前の発言（");
				expect(earlier.join("\n")).toContain("最新のイラン情勢を教えて");
				expect(data.task.urls ?? []).toEqual(currentUrl ? [currentUrl] : []);
			}
			const tools = JSON.parse(
				JSON.parse(h.workerContexts[0]!)[0]
					.content.split("TOOLS=")[1]
					.split("\n")[0],
			).map((tool: { id: string }) => tool.id);
			expect(tools.includes("web.read")).toBe(!!currentUrl);
			expect(h.reported()).toContain("26度");
		} finally {
			await h.close();
		}
	});
