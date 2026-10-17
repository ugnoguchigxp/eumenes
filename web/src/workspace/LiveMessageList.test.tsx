import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { LiveMessageList } from "./LiveMessageList";

vi.mock("../domains/dialogue", () => ({ useRunProgress: () => "" }));
vi.mock("../components/domains/conversation/MessageList", () => ({
	MessageList: () => null,
}));
afterEach(cleanup);

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
