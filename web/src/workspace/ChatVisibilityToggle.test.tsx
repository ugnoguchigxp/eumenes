import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatVisibilityToggle } from "./ChatVisibilityToggle";

afterEach(cleanup);

test("the toggle names the action and reports background mode as pressed", () => {
	const onToggle = vi.fn();
	const view = render(
		<ChatVisibilityToggle hidden={false} onToggle={onToggle} />,
	);
	const hide = screen.getByRole("button", { name: "チャットを隠す" });
	expect(hide.getAttribute("aria-pressed")).toBe("false");
	fireEvent.click(hide);
	expect(onToggle).toHaveBeenCalledOnce();
	view.rerender(<ChatVisibilityToggle hidden onToggle={onToggle} />);
	expect(
		screen
			.getByRole("button", { name: "チャットを表示" })
			.getAttribute("aria-pressed"),
	).toBe("true");
});
