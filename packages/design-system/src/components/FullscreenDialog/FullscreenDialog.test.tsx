import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FullscreenDialog } from "./FullscreenDialog";
afterEach(cleanup);
it("names the workspace, focuses content and returns close through the controlled contract", () => {
	const change = vi.fn();
	render(
		<FullscreenDialog open title="制作画面" onOpenChange={change}>
			<button type="button">操作する</button>
		</FullscreenDialog>,
	);
	expect(screen.getByRole("dialog", { name: "制作画面" })).toBeTruthy();
	expect(document.activeElement?.closest("[role=dialog]")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
	expect(change).toHaveBeenCalledWith(false);
});
