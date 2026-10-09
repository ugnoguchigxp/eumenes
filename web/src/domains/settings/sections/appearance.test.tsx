import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppearanceSection } from "./appearance";
import { settingsFixture } from "./fixture";

afterEach(cleanup);
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
