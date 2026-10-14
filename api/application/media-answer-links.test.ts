import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { imageFixture, imageQuestion } from "./image.fixture";
import { musicFixture, musicQuestion } from "./music.fixture";

for (const media of ["image", "music"] as const)
	test(`${media} completion reports no invented link in progress or final answer`, async () => {
		const fixture = media === "image" ? imageFixture() : musicFixture();
		const claim =
			"完成しました。\n再生：[https://127.0.0.1:8000/play/(127.0.0.1)](https://127.0.0.1:8000/play/\\(127.0.0.1\\))";
		const model = {
			...fixture.model,
			answer: async (...args: Parameters<typeof fixture.model.answer>) =>
				args[0].some((message) =>
					message.content.includes(
						media === "image" ? '"imageResult":' : '"musicResult":',
					),
				)
					? claim
					: fixture.model.answer(...args),
		};
		const h = await harness({
			model,
			...(media === "image"
				? { imageGateway: fixture.gateway }
				: { musicGateway: fixture.gateway }),
		});
		const progress: string[] = [];
		let unsubscribe = () => {};
		try {
			const submitted = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: media === "image" ? imageQuestion : musicQuestion,
				})
			).json();
			unsubscribe = h.dialogue.subscribeProgress(submitted.id, (item) =>
				progress.push(item.text),
			);
			expect(
				(await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
			const answer = h.dialogue.answerText(submitted.id);
			expect(answer).toBe("完成しました。");
			expect(answer).not.toContain("http");
			expect(progress.every((item) => !item.includes("http"))).toBe(true);
		} finally {
			unsubscribe();
			await h.close();
		}
	});
