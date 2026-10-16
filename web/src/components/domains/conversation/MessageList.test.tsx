import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SpeechDelivery } from "../../../../../api/domains/delivery/contracts";
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
test("activity after a request stays outside the user's bubble and before the answer", () => {
	const { container } = render(
		<MessageList
			conversation={{
				id: "main",
				revision: 1,
				messages: [
					{ ...base, id: "user", role: "user", text: "今日の鎌倉の天気は。" },
					{ ...base, id: "answer", role: "assistant", text: "回答" },
				],
			}}
			renderFollowingMessage={(message) =>
				message.id === "user" ? <aside>検索中</aside> : null
			}
		/>,
	);
	const userBubble = container.querySelector(".message-user");
	const activity = screen.getByText("検索中");
	expect(userBubble?.textContent).toBe("あなた今日の鎌倉の天気は。");
	expect(userBubble?.nextElementSibling).toBe(activity);
	expect(activity.nextElementSibling).toBe(
		container.querySelector(".message-assistant"),
	);
});
test("a result action stays inside the answer bubble and outside spoken text", () => {
	const replay = vi.fn();
	const { container } = render(
		<MessageList
			conversation={convo(["answer", "assistant", "楽曲ができました。"])}
			onReplay={replay}
			renderInsideMessage={(message) =>
				message.role === "assistant" ? (
					<button>アーティファクトで再生する</button>
				) : null
			}
		/>,
	);
	const action = screen.getByRole("button", {
		name: "アーティファクトで再生する",
	});
	expect(action.closest(".message-assistant")).toBe(
		container.querySelector(".message-assistant"),
	);
	expect(container.querySelector(".markdown-content")?.textContent).toBe(
		"楽曲ができました。",
	);
	fireEvent.click(screen.getByRole("button", { name: "読み上げ直す" }));
	expect(replay).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ text: "楽曲ができました。" }),
	);
});
test("artifact control input stays available to the model but is absent from chat bubbles", () => {
	const { container } = render(
		<MessageList
			conversation={{
				id: "main",
				revision: 1,
				messages: [
					{
						...base,
						id: "internal",
						role: "user",
						text: '{"prompt":"森","width":512}',
						presentation: "artifact",
					},
					{
						...base,
						id: "answer",
						role: "assistant",
						text: "画像ができました。",
					},
				],
			}}
		/>,
	);
	expect(container.querySelector(".message-user")).toBeNull();
	expect(container.querySelector(".message-assistant")?.textContent).toContain(
		"画像ができました。",
	);
	expect(screen.queryByText(/width/)).toBeNull();
});
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

test("Ruri emotion is displayed and attributed to Ruri", () => {
	const view = render(
		<MessageList
			conversation={{
				id: "c",
				revision: 1,
				messages: [
					{
						id: "a",
						conversationId: "c",
						role: "assistant",
						text: "おめでとうございます。",
						createdAt: "2026-10-09",
						runId: "r",
						delivery: { ...delivery, source: "ruri" },
					},
				],
			}}
		/>,
	);
	expect(
		view.container.querySelector('[data-emotion-source="ruri"]'),
	).not.toBeNull();
});

const convo = (...messages: Array<[string, "user" | "assistant", string]>) => ({
	id: "main",
	revision: 1,
	messages: messages.map(([id, role, text]) => ({ ...base, id, role, text })),
});
const live = (container: HTMLElement) =>
	container.querySelector("output[aria-live]")?.textContent;

test("history on first render is not announced; new answers are, even with identical text", () => {
	const long = "あ".repeat(100);
	const announced = `回答が完了しました。${long}`;
	const { container, rerender } = render(
		<MessageList conversation={convo(["a1", "assistant", "古い回答"])} />,
	);
	expect(live(container)).toBe("");
	rerender(
		<MessageList
			conversation={convo(
				["a1", "assistant", "古い回答"],
				["a2", "assistant", long],
			)}
		/>,
	);
	expect(live(container)).toBe(announced);
	const first = container.querySelector("output[aria-live]");
	rerender(
		<MessageList
			conversation={convo(
				["a1", "assistant", "古い回答"],
				["a2", "assistant", long],
				["a3", "assistant", long],
			)}
		/>,
	);
	expect(live(container)).toBe(announced);
	expect(container.querySelector("output[aria-live]")).not.toBe(first);
});

test("a very long answer is announced up to a limit with a pointer to the text", () => {
	const veryLong = "い".repeat(800);
	const { container, rerender } = render(
		<MessageList conversation={convo(["a1", "assistant", "古い回答"])} />,
	);
	rerender(
		<MessageList
			conversation={convo(
				["a1", "assistant", "古い回答"],
				["a2", "assistant", veryLong],
			)}
		/>,
	);
	expect(live(container)).toBe(
		`回答が完了しました。${"い".repeat(500)}…続きは会話欄で確認できます。`,
	);
});

test("the newest 20 bubbles render first and older bubbles appear 20 at a time", () => {
	const many = Array.from(
		{ length: 45 },
		(_, i): ["user" | "assistant", string] => ["user", `発言${i}`],
	).map(([role, text], i): [string, "user" | "assistant", string] => [
		`m${i}`,
		role,
		text,
	]);
	const { container } = render(<MessageList conversation={convo(...many)} />);
	const articles = () => container.querySelectorAll("article");
	const older = () => screen.getByRole("button", { name: "さらに20件表示" });
	expect(articles()).toHaveLength(20);
	expect(articles()[0]?.textContent).toContain("発言25");
	expect(older().nextElementSibling).toBe(articles()[0]);
	fireEvent.click(older());
	expect(articles()).toHaveLength(40);
	expect(articles()[0]?.textContent).toContain("発言5");
	fireEvent.click(older());
	expect(articles()).toHaveLength(45);
	expect(articles()[0]?.textContent).toContain("発言0");
	expect(screen.queryByRole("button", { name: "さらに20件表示" })).toBeNull();
});

test("a streaming answer counts as one visible bubble", () => {
	const many = Array.from(
		{ length: 20 },
		(_, i) => [`m${i}`, "user", `発言${i}`] as [string, "user", string],
	);
	const conversation = convo(...many);
	const { container, rerender } = render(
		<MessageList conversation={conversation} streaming="回答中" />,
	);
	expect(container.querySelectorAll("article")).toHaveLength(20);
	expect(container.querySelector("article")?.textContent).toContain("発言1");
	expect(screen.getByRole("button", { name: "さらに20件表示" })).toBeTruthy();
	rerender(<MessageList conversation={conversation} />);
	expect(container.querySelectorAll("article")).toHaveLength(20);
	expect(screen.queryByRole("button", { name: "さらに20件表示" })).toBeNull();
});
