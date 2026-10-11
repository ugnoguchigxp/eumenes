import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationStatus } from "./GenerationStatus";

afterEach(cleanup);
it("does not invent a percentage and delegates cancellation", () => {
	const cancel = vi.fn();
	const { rerender } = render(
		<GenerationStatus
			status="running"
			title="生成中"
			description="仕上げています"
			onCancel={cancel}
		/>,
	);
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "生成を取り消す" }));
	expect(cancel).toHaveBeenCalledOnce();
	rerender(
		<GenerationStatus
			status="running"
			title="生成中"
			progress={47}
			onCancel={cancel}
			cancelling
		/>,
	);
	expect(screen.getByRole("progressbar")).toHaveAttribute("value", "47");
	expect(screen.getByRole("button", { name: "取消中…" })).toBeDisabled();
});
it("shows failure and allows only explicit retry", () => {
	const retry = vi.fn();
	render(
		<GenerationStatus
			status="failed"
			title="生成できませんでした"
			onRetry={retry}
		/>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent("生成できませんでした");
	expect(retry).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "再試行" }));
	expect(retry).toHaveBeenCalledOnce();
});
