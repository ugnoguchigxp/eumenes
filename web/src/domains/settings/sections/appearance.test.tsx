import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppearanceSection } from "./appearance";
import { settingsFixture } from "./fixture";

afterEach(cleanup);
test("background selection edits only the saved background preference", () => {
	const value = settingsFixture();
	const previous = structuredClone(value);
	render(<AppearanceSection value={value} change={(edit) => edit(value)} />);
	expect((screen.getByLabelText("会話の背景") as HTMLSelectElement).value).toBe(
		"light-fairy",
	);
	fireEvent.change(screen.getByLabelText("会話の背景"), {
		target: { value: "spatial" },
	});
	expect(value).toEqual({
		...previous,
		general: { ...previous.general, background: "spatial" },
	});
});
test("appearance section renders the theme and subtitle controls", () => {
	const change = vi.fn();
	render(<AppearanceSection value={settingsFixture()} change={change} />);
	expect(screen.getByText("表示")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("テーマ"), {
		target: { value: "dark" },
	});
	expect(change).toHaveBeenCalledOnce();
	expect(screen.getByText("これは字幕のプレビューです。")).toBeTruthy();
});
