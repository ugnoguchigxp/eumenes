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

test("the supervision approval toggle is on by default and reports edits", () => {
	const change = vi.fn();
	render(<GeneralSection value={settingsFixture()} change={change} />);
	const toggle = screen.getByLabelText(
		/監督AIの指示を実行前に確認する/,
	) as HTMLInputElement;
	expect(toggle.checked).toBe(true);
	fireEvent.click(toggle);
	expect(change).toHaveBeenCalledOnce();
	const draft = settingsFixture();
	change.mock.calls[0]![0](draft);
	expect(draft.codingSupervision.approveInstructions).toBe(false);
});
