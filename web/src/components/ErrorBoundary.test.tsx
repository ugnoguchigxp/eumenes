import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test("shows an alert for a throwing child and re-renders it on reset", () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	let broken = true;
	const onReset = vi.fn();
	function Child() {
		if (broken) throw new Error("secret detail");
		return <p>復旧しました</p>;
	}
	render(
		<ErrorBoundary label="settings" onReset={onReset}>
			<Child />
		</ErrorBoundary>,
	);
	expect(screen.getByRole("alert").textContent).toContain(
		"表示中にエラーが発生しました。",
	);
	expect(log).toHaveBeenCalledWith("ui.render_failed", {
		label: "settings",
		name: "Error",
	});
	broken = false;
	fireEvent.click(screen.getByRole("button", { name: "再表示" }));
	expect(onReset).toHaveBeenCalledOnce();
	expect(screen.getByText("復旧しました")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});
