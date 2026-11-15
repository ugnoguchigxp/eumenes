import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { LiveMessageList } from "./LiveMessageList";

const progress = vi.hoisted(() => ({ text: "" }));
vi.mock("../domains/dialogue", () => ({ useRunProgress: () => progress.text }));
vi.mock("../components/domains/conversation/MessageList", () => ({
	MessageList: ({ streaming }: { streaming: string }) => (
		<div data-testid="draft">{streaming}</div>
	),
}));
afterEach(() => {
	cleanup();
	progress.text = "";
});

test("adopted notices trigger the existing pinned-scroll callback even without answer tokens", () => {
	const followLatestIfPinned = vi.fn();
	const props: ComponentProps<typeof LiveMessageList> = {
		conversation: undefined,
		client: {} as ComponentProps<typeof LiveMessageList>["client"],
		activeRunId: "run",
		followLatestIfPinned,
	};
	const view = render(<LiveMessageList {...props} />);
	followLatestIfPinned.mockClear();
	view.rerender(<LiveMessageList {...props} announcement="お調べします。" />);
	expect(followLatestIfPinned).toHaveBeenCalledTimes(1);
	view.rerender(<LiveMessageList {...props} announcement="お調べします。" />);
	expect(followLatestIfPinned).toHaveBeenCalledTimes(1);
	view.rerender(
		<LiveMessageList
			{...props}
			announcement="お調べします。\n制作担当に引き継ぎます。"
		/>,
	);
	expect(followLatestIfPinned).toHaveBeenCalledTimes(2);
});

test("the adopted answer of this run removes the temporary row without hiding another run's draft", () => {
	progress.text = "途中の本文。";
	const props: ComponentProps<typeof LiveMessageList> = {
		client: {} as ComponentProps<typeof LiveMessageList>["client"],
		activeRunId: "run",
		followLatestIfPinned: () => {},
		conversation: { id: "main", revision: 1, messages: [] },
	};
	const view = render(<LiveMessageList {...props} />);
	expect(view.getByTestId("draft").textContent).toBe("途中の本文。");
	const conversation = {
		id: "main",
		revision: 2,
		messages: [
			{
				id: "answer",
				conversationId: "main",
				role: "assistant" as const,
				text: "採用した本文。",
				createdAt: "2026-11-15T00:00:00Z",
				runId: "run",
			},
		],
	};
	view.rerender(<LiveMessageList {...props} conversation={conversation} />);
	expect(view.getByTestId("draft").textContent).toBe("");
	view.rerender(
		<LiveMessageList
			{...props}
			conversation={conversation}
			activeRunId="other"
		/>,
	);
	expect(view.getByTestId("draft").textContent).toBe("途中の本文。");
});
