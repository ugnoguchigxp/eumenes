import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { SpeechDelivery } from "../../../../../api/domains/delivery";
import { MessageList } from "./MessageList";
afterEach(cleanup);
const delivery: SpeechDelivery = {
	id: "00000000-0000-4000-8000-000000000001",
	version: 2,
	emotion: "joy",
	emotionConfidence: 0.9,
	confidence: 0.9,
	source: "laya",
	motion: "joyful",
	tone: "bright",
	latencyMs: 100,
};
const base = { conversationId: "main", createdAt: "now", runId: "run" };
test("adopted emotion belongs beside the assistant name, preserves body and follows a custom name", () => {
	const { container, rerender } = render(
		<MessageList
			agentName="光"
			conversation={{
				id: "main",
				revision: 1,
				messages: [
					{ ...base, id: "user", role: "user", text: "良い知らせ", delivery },
					{
						...base,
						id: "answer",
						role: "assistant",
						text: "**よかったですね。**",
						delivery,
					},
					{
						...base,
						id: "old",
						role: "assistant",
						text: "以前の回答",
						avatarMotion: "sleepy",
					},
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
						text: "素敵な由来ですね。",
						delivery: { ...delivery, emotion: "warmth", motion: "agreeing" },
					},
				],
			}}
		/>,
	);
	expect(
		screen.getByRole("img", { name: "親しみ" }).parentElement?.textContent,
	).toBe("Eumenes🙂");
});
test("plain, fallback, weak confidence and legacy motion are not displayed as emotions", () => {
	const messages = [
		{ ...delivery, emotion: "none" as const, motion: "neutral" as const },
		{ ...delivery, source: "fallback" as const },
		{ ...delivery, emotionConfidence: 0.3 },
		undefined,
	].map((d, i) => ({
		...base,
		id: `${i}`,
		role: "assistant" as const,
		text: "説明",
		delivery: d,
		avatarMotion: "sleepy" as const,
	}));
	render(<MessageList conversation={{ id: "main", revision: 1, messages }} />);
	expect(screen.queryAllByRole("img")).toHaveLength(0);
});
