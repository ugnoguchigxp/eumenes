import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TimerWorkspace } from "./TimerWorkspace";

afterEach(cleanup);
test("presets change the editable time while retaining the name", () => {
	const start = vi.fn();
	render(<TimerWorkspace state="setup" onStart={start} />);
	fireEvent.change(screen.getByLabelText("名前（任意）"), {
		target: { value: "休憩" },
	});
	fireEvent.click(screen.getByRole("button", { name: "25分" }));
	expect(
		screen.getByRole("button", { name: "25分" }).getAttribute("aria-pressed"),
	).toBe("true");
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "30" } });
	fireEvent.submit(screen.getByLabelText("分").closest("form")!);
	expect(start).toHaveBeenCalledWith({
		hours: "00",
		minutes: "25",
		seconds: "30",
		label: "休憩",
	});
});
test("a pending operation blocks another submit and preset edits", () => {
	const start = vi.fn();
	render(<TimerWorkspace state="setup" busy onStart={start} />);
	fireEvent.submit(
		screen.getByRole("button", { name: "開始する" }).closest("form")!,
	);
	expect(start).not.toHaveBeenCalled();
	expect(screen.getByLabelText("分")).toBeDisabled();
	expect(screen.getByRole("button", { name: "5分" })).toBeDisabled();
});
test("the running display reports host time and cancellation, without creating a local clock", () => {
	const cancel = vi.fn();
	const view = render(
		<TimerWorkspace
			state="active"
			remainingSeconds={90}
			durationSeconds={180}
			onCancel={cancel}
		/>,
	);
	expect(screen.getByRole("timer")).toHaveTextContent("01:30");
	fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
	expect(cancel).toHaveBeenCalledOnce();
	view.rerender(
		<TimerWorkspace
			state="elapsed"
			remainingSeconds={0}
			durationSeconds={180}
			onCancel={cancel}
		/>,
	);
	expect(screen.getByRole("timer")).toHaveTextContent("00:00");
	expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
	expect(screen.getByText("時間になりました")).toBeVisible();
});
