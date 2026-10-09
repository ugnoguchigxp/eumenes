import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { settingsFixture } from "./fixture";
import { GeneralSection } from "./general";

afterEach(cleanup);
test("general section renders the conversation fields and reports edits", () => {
	const change = vi.fn();
	render(<GeneralSection value={settingsFixture()} change={change} />);
	expect(screen.getByText("会話")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "Laya" },
	});
	expect(change).toHaveBeenCalledOnce();
});
