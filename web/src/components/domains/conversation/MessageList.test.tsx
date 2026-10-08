import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MessageList } from "./MessageList";
afterEach(cleanup);
test("Laya emoji belongs to the assistant author, preserves text and follows a custom name", () => {
	const base = { conversationId: "main", createdAt: "now", runId: "run" };
	const { container, rerender } = render(
		<MessageList
			agentName="光"
			conversation={{
				id: "main",
				revision: 1,
				messages: [
					{
						...base,
						id: "user",
						role: "user",
						text: "良い知らせ",
						avatarMotion: "joyful",
					},
					{
						...base,
						id: "answer",
						role: "assistant",
						text: "**よかったですね。**",
						avatarMotion: "joyful",
					},
					{ ...base, id: "old", role: "assistant", text: "以前の回答" },
				],
			}}
		/>,
	);
	expect(screen.getAllByRole("img")).toHaveLength(1);
	expect(
		screen.getByRole("img", { name: "喜び" }).parentElement?.textContent,
	).toBe("光😊");
	expect(container.querySelector(".markdown-content")?.textContent).toBe(
		"よかったですね。",
	);
	rerender(
		<MessageList
			conversation={{
				id: "main",
				revision: 2,
				messages: [
					{
						...base,
						id: "answer",
						role: "assistant",
						text: "検討しましょう。",
						avatarMotion: "thinking",
					},
				],
			}}
		/>,
	);
	expect(
		screen.getByRole("img", { name: "考える" }).parentElement?.textContent,
	).toBe("Eumenes🤔");
});
