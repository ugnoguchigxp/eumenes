import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Subtitle, SubtitlePreview } from ".";
afterEach(cleanup);

test("preview updates the same subtitle renderer and keeps an off-state design sample", () => {
	const view = render(
		<SubtitlePreview text="見本" style="prime" size="medium" enabled />,
	);
	expect(screen.getByTestId("subtitle")).toHaveAttribute("data-style", "prime");
	expect(screen.getByTestId("subtitle")).toHaveClass("subtitle-inline");
	view.rerender(
		<SubtitlePreview text="見本" style="glass" size="xlarge" enabled={false} />,
	);
	expect(screen.getByTestId("subtitle")).toHaveAttribute("data-style", "glass");
	expect(screen.getByTestId("subtitle")).toHaveAttribute("data-size", "xlarge");
	expect(screen.getByText(/字幕は非表示の設定/)).toBeInTheDocument();
	expect(screen.getByText("見本")).toBeInTheDocument();
});
test("speech overlays stay separate from document flow and duplicate spoken words are hidden from screen readers", () => {
	render(<Subtitle text="読み上げ中" style="classic" size="large" />);
	expect(screen.getByTestId("subtitle")).not.toHaveClass("subtitle-inline");
	expect(screen.getByTestId("subtitle")).toHaveAttribute("aria-hidden", "true");
});
